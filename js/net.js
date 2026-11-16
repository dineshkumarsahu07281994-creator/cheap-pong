// Serverless random matchmaking over the free public PeerJS broker (same scheme as CheapChess).
//
// Everyone races to claim one well-known peer ID, the "lobby slot". The broker hands out
// each ID to only one client at a time, so exactly one waiting player holds the slot. The
// next player fails to claim it ("unavailable-id") and connects to the holder instead.
// Once paired, both players drop their broker connection: the WebRTC data channel between
// them stays up, and the slot is free again for the next pair.
//
// The slot holder becomes the match "host": it runs the ball physics for both players.

export const PROTOCOL_VERSION = 1;

const HANDSHAKE_MS = 10_000;
const MAX_FAILED_ATTEMPTS = 15;

// A host whose guests keep failing to connect is probably unreachable itself. It gives the
// slot up for a while so that a reachable player can host instead of everyone stalling on it.
const MAX_HOST_FAILURES = 2;
const HOST_BACKOFF_MS = 10_000;
const WARN_AFTER_FAILURES = 2;
const NETWORK_WARNING = 'Opponents were found but the connection failed. Your network may block direct play.';

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function lobbyId() {
  // ?lobby=xyz gives a separate queue, e.g. for testing or for friends playing among themselves.
  const requested = new URLSearchParams(location.search).get('lobby') || window.CHEAPPONG_LOBBY || 'main';
  const room = String(requested).replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'main';
  return `cheappong-v${PROTOCOL_VERSION}-${room.toLowerCase()}`;
}

// STUN only finds a direct route. Players behind strict NATs also need a TURN relay, which
// comes from window.CHEAPPONG_TURN_CREDENTIALS_URL (see config.js).
async function iceServers() {
  const url = window.CHEAPPONG_TURN_CREDENTIALS_URL;
  if (!url) return STUN_SERVERS;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    const turn = Array.isArray(body) ? body : body.iceServers;
    if (res.ok && Array.isArray(turn)) return [...STUN_SERVERS, ...turn];
    console.warn('CheapPong: TURN credentials response had no ice servers', res.status, body);
  } catch (err) {
    console.warn('CheapPong: could not fetch TURN credentials; direct connections only', err);
  }
  return STUN_SERVERS;
}

/**
 * Resolves with { peer, conn, isHost, opponentName } once paired. The caller owns `peer`
 * and `conn` afterwards and must destroy them.
 */
export async function findOpponent({ name, onStatus = () => {}, signal }) {
  const Peer = window.Peer;
  if (!Peer) throw new Error('Could not load the networking library. Check your connection and reload.');

  onStatus('Looking for an opponent…');
  // Set window.CHEAPPONG_PEER_SERVER = { host, port, path, secure } to use your own broker.
  const peerOptions = {
    debug: 0,
    config: { iceServers: await iceServers() },
    ...(window.CHEAPPONG_PEER_SERVER || {}),
  };
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  return new Promise((resolve, reject) => {
    let peer = null;
    let settled = false;
    let failures = 0;
    let hostFailures = 0;
    let connectFailures = 0; // handshakes that started but never completed, as host or guest
    const timers = new Set();

    const status = (text) => onStatus(connectFailures >= WARN_AFTER_FAILURES ? `${text} ${NETWORK_WARNING}` : text);
    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    };
    const cancelTimer = (id) => { clearTimeout(id); timers.delete(id); };
    const dropPeer = () => {
      // Clear the reference first: destroy() fires 'disconnected'/'close' synchronously, and
      // the handlers ignore events from any peer that is no longer the current one.
      const old = peer;
      peer = null;
      if (old && !old.destroyed) old.destroy();
    };

    const succeed = (result) => {
      settled = true;
      timers.forEach(clearTimeout);
      timers.clear();
      result.peer.disconnect(); // leave the broker; the data channel survives
      resolve(result);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      timers.clear();
      dropPeer();
      reject(err);
    };
    const retry = (counts = true, delay = 300 + Math.random() * 900) => {
      if (settled) return;
      dropPeer();
      if (counts && ++failures > MAX_FAILED_ATTEMPTS) {
        fail(new Error('Could not reach the matchmaking service. Check your connection and try again.'));
        return;
      }
      later(tryHost, delay);
    };

    signal?.addEventListener('abort', () => fail(new DOMException('Cancelled', 'AbortError')));

    function tryHost() {
      if (settled) return;
      status('Looking for an opponent…');
      const me = (peer = new Peer(lobbyId(), peerOptions));
      let busy = false; // a guest is mid-handshake

      me.on('open', () => status('Waiting for an opponent…'));

      me.on('connection', (conn) => {
        if (settled || busy) {
          conn.on('open', () => {
            conn.send({ t: 'busy' });
            setTimeout(() => conn.close(), 500);
          });
          return;
        }
        busy = true;
        let ended = false;
        const handshakeFailed = () => {
          if (ended || settled || me !== peer) return;
          ended = true;
          cancelTimer(timeout);
          busy = false;
          conn.removeAllListeners();
          conn.close();
          connectFailures++;
          if (++hostFailures >= MAX_HOST_FAILURES) {
            hostFailures = 0;
            retry(false, HOST_BACKOFF_MS + Math.random() * 5000);
          } else {
            status('Waiting for an opponent…');
          }
        };
        const timeout = later(handshakeFailed, HANDSHAKE_MS);

        conn.on('data', (msg) => {
          if (!msg || msg.t !== 'hello' || settled || ended) return;
          ended = true;
          cancelTimer(timeout);
          if (msg.v !== PROTOCOL_VERSION) {
            conn.send({ t: 'busy' });
            busy = false;
            conn.removeAllListeners();
            setTimeout(() => conn.close(), 500);
            return;
          }
          conn.send({ t: 'start', v: PROTOCOL_VERSION, name });
          conn.removeAllListeners();
          succeed({ peer: me, conn, isHost: true, opponentName: msg.name });
        });
        conn.on('close', handshakeFailed);
        conn.on('error', handshakeFailed);
      });

      me.on('disconnected', () => { if (!settled && me === peer) retry(); });
      me.on('error', (err) => {
        if (settled || me !== peer) return;
        if (err.type === 'unavailable-id') {
          // Someone is already waiting: go and play them.
          dropPeer();
          tryJoin();
        } else {
          retry();
        }
      });
    }

    function tryJoin() {
      if (settled) return;
      status('Opponent found, connecting…');
      const me = (peer = new Peer(peerOptions));
      let timeout = null;
      const handshakeFailed = () => {
        if (settled || me !== peer) return;
        cancelTimer(timeout);
        connectFailures++;
        retry(false);
      };

      me.on('open', () => {
        const conn = me.connect(lobbyId(), { reliable: true, serialization: 'json' });
        timeout = later(handshakeFailed, HANDSHAKE_MS);

        conn.on('open', () => conn.send({ t: 'hello', v: PROTOCOL_VERSION, name }));
        conn.on('data', (msg) => {
          if (!msg || settled || me !== peer) return;
          if (msg.t === 'busy') {
            cancelTimer(timeout);
            retry(false); // the waiting player was just paired with someone else
          } else if (msg.t === 'start' && msg.v === PROTOCOL_VERSION) {
            cancelTimer(timeout);
            conn.removeAllListeners();
            succeed({ peer: me, conn, isHost: false, opponentName: msg.name });
          }
        });
        conn.on('close', handshakeFailed);
      });

      me.on('error', (err) => {
        if (settled || me !== peer) return;
        if (timeout) cancelTimer(timeout);
        // 'peer-unavailable': the waiting player left or was paired, so try to take the slot.
        retry(err.type !== 'peer-unavailable');
      });
    }

    tryHost();
  });
}
