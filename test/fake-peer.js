// Test double for PeerJS, for playing both sides in one browser without WebRTC.
// Peer IDs are Web Locks (one holder per ID, like the real broker) and the "data channel"
// is a BroadcastChannel, so every frame/tab of the same origin is on the same network.
// window.FAKE_PEER_LATENCY_MS delays every message to imitate a real connection.
(function () {
  const wire = new BroadcastChannel('fake-peerjs');
  const latency = () => window.FAKE_PEER_LATENCY_MS ?? 40;
  const later = (fn) => setTimeout(fn, latency());
  let nextId = 1;

  class Emitter {
    constructor() { this._ls = {}; }
    on(ev, fn) { (this._ls[ev] ||= []).push(fn); return this; }
    emit(ev, ...args) { for (const fn of [...(this._ls[ev] || [])]) fn(...args); }
    removeAllListeners() { this._ls = {}; }
  }

  class FakeConn extends Emitter {
    constructor(peer, remote, cid) {
      super();
      Object.assign(this, { peer: remote, _owner: peer, _cid: cid, open: false, _closed: false });
    }
    send(data) {
      if (!this.open) return;
      const payload = JSON.parse(JSON.stringify(data));
      later(() => wire.postMessage({ to: this.peer, from: this._owner.id, cid: this._cid, kind: 'data', data: payload }));
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      this.open = false;
      later(() => wire.postMessage({ to: this.peer, from: this._owner.id, cid: this._cid, kind: 'close' }));
      this.emit('close');
    }
    _remoteClosed() {
      if (this._closed) return;
      this._closed = true;
      this.open = false;
      this.emit('close');
    }
  }

  class FakePeer extends Emitter {
    constructor(id, _opts) {
      super();
      if (typeof id !== 'string') id = `anon-${Math.random().toString(36).slice(2, 10)}`;
      this.id = id;
      this.destroyed = false;
      this.disconnected = false;
      this._conns = new Map();
      this._onWire = (e) => this._receive(e.data);
      wire.addEventListener('message', this._onWire);
      navigator.locks.request(`fakepeer:${id}`, { ifAvailable: true }, (lock) => {
        if (this.destroyed) return undefined;
        if (!lock) {
          setTimeout(() => this.emit('error', { type: 'unavailable-id' }), 30);
          return undefined;
        }
        setTimeout(() => this.emit('open', id), 30);
        return new Promise((release) => { this._release = release; });
      });
    }

    connect(remote) {
      const cid = `${this.id}#${nextId++}`;
      const conn = new FakeConn(this, remote, cid);
      this._conns.set(cid, conn);
      navigator.locks.query().then(({ held }) => {
        if (!held.some((l) => l.name === `fakepeer:${remote}`)) {
          this.emit('error', { type: 'peer-unavailable' });
          return;
        }
        later(() => wire.postMessage({ to: remote, from: this.id, cid, kind: 'connect' }));
      });
      return conn;
    }

    _receive(m) {
      if (this.destroyed || m.to !== this.id) return;
      if (m.kind === 'connect') {
        if (this.disconnected) return; // no longer reachable through the broker
        const conn = new FakeConn(this, m.from, m.cid);
        this._conns.set(m.cid, conn);
        this.emit('connection', conn);
        later(() => wire.postMessage({ to: m.from, from: this.id, cid: m.cid, kind: 'accept' }));
        setTimeout(() => { conn.open = true; conn.emit('open'); }, latency());
        return;
      }
      const conn = this._conns.get(m.cid);
      if (!conn) return;
      if (m.kind === 'accept') { conn.open = true; conn.emit('open'); }
      else if (m.kind === 'data') { if (conn.open) conn.emit('data', m.data); }
      else if (m.kind === 'close') conn._remoteClosed();
    }

    // Real PeerJS: leaves the broker (the ID becomes free) but data channels stay up.
    disconnect() {
      this.disconnected = true;
      this._release?.();
    }

    destroy() {
      if (this.destroyed) return;
      this._conns.forEach((c) => c.close());
      this.destroyed = true;
      this._release?.();
      wire.removeEventListener('message', this._onWire);
      this.emit('disconnected');
      this.emit('close');
    }
  }

  window.Peer = FakePeer;
})();
