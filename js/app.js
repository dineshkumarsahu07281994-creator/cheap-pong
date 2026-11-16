import { findOpponent } from './net.js';
import * as P from './game.js';
import { Renderer } from './render.js';
import { Sound } from './sound.js';

// There is no game server. The player who was waiting in the lobby slot becomes the host: its
// browser runs the ball physics and streams the match state to the guest ~30 times a second.
// Each player owns their own paddle and sends its position. The guest draws the ball by
// predicting forward from the latest snapshot, so it moves smoothly between updates.

const SNAPSHOT_MS = 33;        // host -> guest match state
const PAD_SEND_MS = 33;        // guest -> host paddle position
const PAD_KEEPALIVE_MS = 250;  // resend an unchanged paddle this often
const PING_EVERY_MS = 1000;
const OPPONENT_TIMEOUT_MS = 15000;
const MAX_PREDICT_S = 0.25;    // never extrapolate the ball further than this past a snapshot
const SMOOTH_MS = 70;          // how quickly the guest blends away small ball corrections
const SNAP_DISTANCE = 90;      // a correction bigger than this is a jump (a new serve), not jitter
const GUEST_PAD_SLACK = 1.5;   // headroom over the legal paddle speed, for bunched-up packets
const NAME_KEY = 'cheappong-name';
const TITLE = document.title;
const AUTOPILOT = Boolean(window.CHEAPPONG_AUTOPILOT); // testing aid: your paddle plays itself

const $ = (id) => document.getElementById(id);
const el = {
  name: $('name'), play: $('play'), lobbyError: $('lobby-error'),
  searchStatus: $('search-status'), searchTime: $('search-time'), cancel: $('cancel'),
  meName: $('me-name'), oppName: $('opp-name'), meScore: $('me-score'), oppScore: $('opp-score'),
  ping: $('ping'), status: $('status'), court: $('court'),
  rematch: $('rematch'), newOpp: $('new-opp'), leave: $('leave'), mute: $('mute'),
};

const renderer = new Renderer(el.court);
const sound = new Sound();
const keys = { up: false, down: false };
let search = null; // AbortController while matchmaking
let g = null;      // the current match

// ---------------------------------------------------------------- lobby & matchmaking

el.name.value = localStorage.getItem(NAME_KEY) || `Guest${Math.floor(1000 + Math.random() * 9000)}`;
el.play.addEventListener('click', startSearch);
el.newOpp.addEventListener('click', startSearch);
el.cancel.addEventListener('click', () => search?.abort());
el.leave.addEventListener('click', () => { leaveMatch(); show('lobby'); });

function show(screen) {
  for (const id of ['lobby', 'searching', 'game']) $(id).hidden = id !== screen;
}

async function startSearch() {
  if (search) return; // already looking; a second search would grab a second lobby slot
  sound.unlock();
  leaveMatch();
  const name = cleanName(el.name.value, 'Guest');
  el.name.value = name;
  localStorage.setItem(NAME_KEY, name);
  el.lobbyError.hidden = true;
  show('searching');

  const started = Date.now();
  el.searchTime.textContent = '';
  const ticker = setInterval(() => {
    el.searchTime.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
  }, 1000);
  search = new AbortController();
  try {
    const match = await findOpponent({
      name,
      signal: search.signal,
      onStatus: (text) => { el.searchStatus.textContent = text; },
    });
    startMatch({ ...match, myName: name });
  } catch (err) {
    show('lobby');
    if (err.name !== 'AbortError') {
      el.lobbyError.textContent = err.message;
      el.lobbyError.hidden = false;
    }
  } finally {
    clearInterval(ticker);
    search = null;
  }
}

function startMatch({ peer, conn, isHost, opponentName, myName }) {
  const now = performance.now();
  g = {
    peer, conn, isHost, myName,
    me: isHost ? 0 : 1, // side 0 = left in world coordinates; the guest's view is mirrored
    oppName: cleanName(opponentName, 'Opponent'),
    connected: true,
    gone: null,          // how the opponent left, once they have
    forfeit: false,      // the match ended because the opponent left
    lastSeen: Date.now(),
    rtt: null,
    match: 1,
    myPad: P.H / 2,
    target: null,        // pointer position the paddle is chasing
    shownOppPad: P.H / 2,
    shownBall: null,     // world-space ball as last drawn
    counters: null,      // event counters from the last frame, for sounds
    lastFrame: now,
    uiKey: '',
    aiDir: 0,
    aiError: 0,
    // host only
    state: isHost ? P.newMatch() : null,
    guestPad: P.H / 2,
    guestTarget: P.H / 2,
    hidden: [false, false],
    rematch: [false, false],
    seq: 0,
    lastSnapshotAt: 0,
    // guest only
    snap: null,
    snapAt: 0,
    lastSeq: -1,
    wantsRematch: false,
    ballOffset: { x: 0, y: 0 },
    lastPadSentAt: 0,
    sentPad: null,
  };
  conn.on('data', onMessage);
  conn.on('close', () => opponentGone('left'));
  conn.on('error', () => opponentGone('lost connection'));
  g.pinger = setInterval(heartbeat, PING_EVERY_MS);
  if (isHost) {
    g.hidden[0] = document.hidden;
    syncPause();
  } else {
    send({ t: 'vis', hidden: document.hidden });
  }
  if (document.hidden) document.title = '● Opponent found · CheapPong';
  show('game');
  g.raf = requestAnimationFrame(frame);
}

function leaveMatch({ immediately = false } = {}) {
  if (!g) return;
  const { conn, peer, connected } = g;
  if (connected) send({ t: 'bye' });
  clearInterval(g.pinger);
  cancelAnimationFrame(g.raf);
  g = null;
  conn.removeAllListeners();
  const close = () => { conn.close(); peer.destroy(); };
  if (immediately) close();
  else setTimeout(close, 200); // let 'bye' get out first
  document.title = TITLE;
}

window.addEventListener('pagehide', () => leaveMatch({ immediately: true }));

// ---------------------------------------------------------------- the frame loop

function frame(now) {
  if (!g) return;
  const dt = Math.min(100, Math.max(0, now - g.lastFrame));
  g.lastFrame = now;
  moveMyPaddle(dt);
  if (g.isHost) hostTick(now, dt);
  else guestTick(now);
  renderer.draw(buildView(now, dt));
  renderUi();
  g.raf = requestAnimationFrame(frame);
}

function moveMyPaddle(dt) {
  const max = (P.PADDLE_SPEED * dt) / 1000;
  const dir = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (AUTOPILOT) g.target = autopilotTarget();
  if (dir) {
    g.target = null;
    g.myPad += dir * max;
  } else if (g.target !== null) {
    g.myPad += clamp(g.target - g.myPad, -max, max);
  }
  g.myPad = P.clampPad(g.myPad);
}

function hostTick(now, dt) {
  const s = g.state;
  // Chase the guest's reported paddle at no more than the legal speed (plus some slack for
  // network jitter), so a modified client can't teleport its paddle onto the ball.
  const max = (P.PADDLE_SPEED * GUEST_PAD_SLACK * dt) / 1000;
  g.guestPad += clamp(g.guestTarget - g.guestPad, -max, max);
  s.pads[0] = g.myPad;
  s.pads[1] = g.guestPad;
  P.step(s, dt);
  playSounds(s);
  if (now - g.lastSnapshotAt >= SNAPSHOT_MS) sendSnapshot(now);
}

function guestTick(now) {
  if (!g.connected) return;
  const since = now - g.lastPadSentAt;
  if (since >= PAD_SEND_MS && (g.myPad !== g.sentPad || since >= PAD_KEEPALIVE_MS)) {
    send({ t: 'pad', y: round1(g.myPad) });
    g.sentPad = g.myPad;
    g.lastPadSentAt = now;
  }
}

// The match state this browser knows: the real one on the host, the latest snapshot on the guest.
function matchState() {
  if (g.isHost) return g.state;
  if (!g.snap) g.snap = { ...P.newMatch(0), rematch: [false, false] }; // opponent left before the first snapshot
  return g.snap;
}

// Guest only: where the ball is now, extrapolated from the last snapshot.
function predictedBall(now) {
  const s = g.snap;
  const age = Math.min(MAX_PREDICT_S, (now - g.snapAt) / 1000 + (g.rtt ?? 0) / 2000);
  return P.predictBall(s.ball, [s.pads[0], g.myPad], age);
}

function buildView(now, dt) {
  const s = g.isHost ? g.state : g.snap;
  if (!s) {
    return { ball: null, myPad: g.myPad, oppPad: P.H / 2, myScore: 0, oppScore: 0, overlay: { small: 'Connecting…' } };
  }

  let ball = s.ball;
  let oppPad;
  if (g.isHost) {
    oppPad = g.guestPad;
  } else {
    if (s.phase === 'play' && g.connected) {
      const p = predictedBall(now);
      const k = Math.exp(-dt / SMOOTH_MS);
      g.ballOffset.x *= k;
      g.ballOffset.y *= k;
      ball = { ...p, x: p.x + g.ballOffset.x, y: p.y + g.ballOffset.y };
    }
    g.shownOppPad += (s.pads[0] - g.shownOppPad) * (1 - Math.exp(-dt / 40));
    oppPad = g.shownOppPad;
  }
  g.shownBall = ball;

  const mirror = g.me === 1;
  return {
    ball: s.phase === 'over' ? null : { x: mirror ? P.W - ball.x : ball.x, y: ball.y },
    myPad: g.myPad,
    oppPad,
    myScore: s.score[g.me],
    oppScore: s.score[1 - g.me],
    overlay: overlayFor(s, now),
  };
}

function overlayFor(s, now) {
  if (s.phase === 'over') {
    const won = s.winner === g.me;
    return {
      big: won ? 'You win!' : 'You lose',
      small: g.forfeit ? `${g.oppName} ${g.gone}` : `${s.score[g.me]} – ${s.score[1 - g.me]}`,
    };
  }
  if (s.phase === 'paused') {
    const hidden = g.isHost ? g.hidden : s.hidden || [false, false];
    return {
      big: 'Paused',
      small: hidden[g.me] ? 'Waiting for you to come back' : `${g.oppName} switched to another tab`,
    };
  }
  if (s.phase === 'countdown') {
    const left = g.isHost ? s.phaseLeft : s.phaseLeft - (now - g.snapAt);
    const start = s.score[0] + s.score[1] === 0;
    return {
      big: String(Math.max(1, Math.ceil(left / 1000))),
      small: start ? `First to ${P.WIN_SCORE}. You are the green paddle.` : 'Get ready',
      dim: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------- messages

function send(msg) {
  if (g?.connected && g.conn.open) g.conn.send(msg);
}

function sendSnapshot(now = performance.now()) {
  if (!g?.isHost) return;
  g.lastSnapshotAt = now;
  const s = g.state;
  send({
    t: 's',
    n: ++g.seq,
    m: g.match,
    b: [round1(s.ball.x), round1(s.ball.y), round1(s.ball.vx), round1(s.ball.vy)],
    p: [round1(s.pads[0]), round1(s.pads[1])],
    sc: s.score,
    ph: s.phase,
    pl: Math.round(s.phaseLeft),
    c: [s.hits, s.walls, s.points],
    w: s.winner,
    rm: g.rematch,
    hid: g.hidden,
  });
}

function onMessage(msg) {
  if (!g || !msg || typeof msg.t !== 'string') return;
  g.lastSeen = Date.now();
  switch (msg.t) {
    case 'ping':
      send({ t: 'pong', ts: msg.ts });
      return;
    case 'pong': {
      const rtt = performance.now() - Number(msg.ts);
      if (rtt >= 0 && rtt < 10_000) g.rtt = g.rtt === null ? rtt : g.rtt * 0.7 + rtt * 0.3;
      return;
    }
    case 'bye':
      opponentGone('left');
      return;
    case 's':
      if (!g.isHost) onSnapshot(msg);
      return;
    case 'pad': {
      const y = Number(msg.y);
      if (g.isHost && Number.isFinite(y)) g.guestTarget = P.clampPad(y);
      return;
    }
    case 'vis':
      if (g.isHost) {
        g.hidden[1] = Boolean(msg.hidden);
        syncPause();
      }
      return;
    case 'rematch':
      if (g.isHost && g.connected && g.state.phase === 'over') {
        g.rematch[1] = true;
        maybeRematch();
      }
      return;
    default:
      return;
  }
}

function onSnapshot(msg) {
  const n = Number(msg.n);
  if (!(n > g.lastSeq)) return;
  const arrays = [[msg.b, 4], [msg.p, 2], [msg.sc, 2], [msg.c, 3]];
  if (!arrays.every(([a, len]) => Array.isArray(a) && a.length === len && a.every(Number.isFinite))) return;
  if (!P.PHASES.includes(msg.ph)) return;
  g.lastSeq = n;

  const now = performance.now();
  const before = g.shownBall; // where the ball is drawn right now
  if (msg.m !== g.match) {
    g.match = msg.m;
    g.wantsRematch = false;
    g.counters = null;
  }
  const [x, y, vx, vy] = msg.b;
  g.snap = {
    ball: { x, y, vx, vy },
    pads: msg.p,
    score: msg.sc,
    phase: msg.ph,
    phaseLeft: Number(msg.pl) || 0,
    hits: msg.c[0],
    walls: msg.c[1],
    points: msg.c[2],
    winner: msg.w === 0 || msg.w === 1 ? msg.w : null,
    rematch: [Boolean(msg.rm?.[0]), Boolean(msg.rm?.[1])],
    hidden: [Boolean(msg.hid?.[0]), Boolean(msg.hid?.[1])],
  };
  g.snapAt = now;

  // Keep drawing the ball where it was and blend towards the corrected path, unless the
  // correction is a big jump such as a new serve.
  g.ballOffset = { x: 0, y: 0 };
  if (before && g.snap.phase === 'play') {
    const after = predictedBall(now);
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    if (Math.hypot(dx, dy) < SNAP_DISTANCE) g.ballOffset = { x: dx, y: dy };
  }
  playSounds(g.snap);
}

function syncPause() {
  const s = g.state;
  if (g.hidden[0] || g.hidden[1]) P.pause(s);
  else P.resume(s);
  sendSnapshot();
}

function maybeRematch() {
  if (g.rematch[0] && g.rematch[1]) {
    g.state = P.newMatch(1 - g.state.firstReceiver); // the other player receives first this time
    g.match++;
    g.rematch = [false, false];
    g.counters = null;
    syncPause();
  } else {
    sendSnapshot();
  }
}

function heartbeat() {
  if (!g?.connected) return;
  send({ t: 'ping', ts: performance.now() });
  if (Date.now() - g.lastSeen > OPPONENT_TIMEOUT_MS) opponentGone('stopped responding');
  // requestAnimationFrame stops in a hidden tab, so keep the guest informed from here.
  else if (g.isHost && document.hidden) sendSnapshot();
}

function opponentGone(how) {
  if (!g?.connected) return;
  closeConnection();
  g.gone = how;
  const s = matchState();
  if (s.phase !== 'over') {
    s.phase = 'over';
    s.winner = g.me;
    g.forfeit = true;
  }
}

function closeConnection() {
  g.connected = false;
  clearInterval(g.pinger);
  const { conn } = g;
  conn.removeAllListeners();
  setTimeout(() => conn.close(), 1000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = TITLE;
  if (!g?.connected) return;
  if (g.isHost) {
    g.hidden[0] = document.hidden;
    syncPause();
  } else {
    send({ t: 'vis', hidden: document.hidden });
  }
});

// ---------------------------------------------------------------- sounds

function playSounds(s) {
  const now = { hits: s.hits, walls: s.walls, points: s.points, mine: s.score[g.me] };
  const prev = g.counters;
  g.counters = now;
  if (!prev) return;
  if (now.points > prev.points) sound.point(now.mine > prev.mine);
  else if (now.hits > prev.hits) sound.paddle();
  else if (now.walls > prev.walls) sound.wall();
}

// ---------------------------------------------------------------- input

const KEYMAP = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down' };

window.addEventListener('keydown', (e) => {
  const key = KEYMAP[e.key];
  if (!key || !g || e.target instanceof HTMLInputElement) return;
  keys[key] = true;
  e.preventDefault(); // don't scroll the page
  sound.unlock();
});
window.addEventListener('keyup', (e) => {
  const key = KEYMAP[e.key];
  if (key) keys[key] = false;
});
window.addEventListener('blur', () => { keys.up = keys.down = false; });

function aimAtPointer(e) {
  if (!g) return;
  const rect = el.court.getBoundingClientRect();
  g.target = ((e.clientY - rect.top) / rect.height) * P.H;
}
el.court.addEventListener('pointermove', aimAtPointer);
el.court.addEventListener('pointerdown', (e) => {
  aimAtPointer(e);
  sound.unlock();
  if (e.pointerType !== 'mouse') el.court.setPointerCapture(e.pointerId);
});

function autopilotTarget() {
  const b = g.shownBall;
  if (!b) return P.H / 2;
  const dir = Math.sign(b.vx);
  if (dir !== g.aiDir) {
    g.aiDir = dir;
    g.aiError = (Math.random() * 2 - 1) * 70; // sometimes more than half a paddle, so it misses
  }
  const towardsMe = g.me === 0 ? b.vx < 0 : b.vx > 0;
  return towardsMe ? b.y + g.aiError : P.H / 2;
}

// ---------------------------------------------------------------- buttons & page text

el.rematch.addEventListener('click', () => {
  if (!g?.connected || matchState().phase !== 'over') return;
  sound.unlock();
  if (g.isHost) {
    g.rematch[0] = true;
    maybeRematch();
  } else {
    g.wantsRematch = true;
    send({ t: 'rematch' });
  }
});

el.mute.addEventListener('click', () => {
  sound.unlock();
  sound.toggle();
  el.mute.textContent = sound.muted ? 'Sound: off' : 'Sound: on';
});
el.mute.textContent = sound.muted ? 'Sound: off' : 'Sound: on';

function renderUi() {
  const s = matchState();
  const over = s.phase === 'over';
  const meWants = g.isHost ? g.rematch[0] : g.wantsRematch || s.rematch[1];
  const oppWants = g.isHost ? g.rematch[1] : s.rematch[0];
  const ping = g.connected && g.rtt !== null ? `${Math.round(g.rtt)} ms` : '';
  const key = [s.score[0], s.score[1], s.phase, g.connected, g.forfeit, meWants, oppWants, ping].join('|');
  if (key === g.uiKey) return;
  g.uiKey = key;

  el.meName.textContent = `${g.myName} (you)`;
  el.oppName.textContent = g.oppName;
  el.meScore.textContent = s.score[g.me];
  el.oppScore.textContent = s.score[1 - g.me];
  el.ping.textContent = ping;

  let text;
  if (over) {
    const mine = s.score[g.me];
    const theirs = s.score[1 - g.me];
    if (g.forfeit) text = `${g.oppName} ${g.gone}. You win by forfeit.`;
    else text = s.winner === g.me ? `You won ${mine}–${theirs}!` : `You lost ${mine}–${theirs}.`;
    if (!g.connected && !g.forfeit) text += ` ${g.oppName} has left.`;
    else if (oppWants && !meWants) text += ` ${g.oppName} wants a rematch.`;
  } else if (s.phase === 'paused') {
    text = 'Paused until both players are back on this tab.';
  } else {
    text = `First to ${P.WIN_SCORE}. Move with the mouse, a finger, or ↑ ↓ / W S.`;
  }
  el.status.textContent = text;
  el.status.classList.toggle('final', over);

  el.rematch.hidden = !over || !g.connected;
  el.rematch.disabled = meWants;
  el.rematch.textContent = meWants ? 'Waiting for opponent…' : oppWants ? 'Accept rematch' : 'Rematch';
  el.newOpp.hidden = !over;
  el.leave.textContent = over ? 'Back to lobby' : 'Leave';
}

// ---------------------------------------------------------------- helpers

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function cleanName(value, fallback) {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || fallback;
}
