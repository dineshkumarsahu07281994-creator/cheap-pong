// Tiny retro blips made with Web Audio, so there are no sound files to download.

const MUTE_KEY = 'cheappong-muted';

export class Sound {
  constructor() {
    this.muted = localStorage.getItem(MUTE_KEY) === '1';
    this.ctx = null;
  }

  // Browsers only allow audio after a user gesture, so call this from click/key handlers.
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    return this.muted;
  }

  beep(freq, ms, volume = 0.05) {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000);
  }

  paddle() { this.beep(520, 60); }
  wall() { this.beep(300, 45); }
  point(mine) { this.beep(mine ? 700 : 180, 260); }
}
