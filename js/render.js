import { W, H, PADDLE_W, PADDLE_H, PADDLE_INSET, BALL_R } from './game.js';

const COLORS = {
  court: '#1b1915',
  line: 'rgba(244, 241, 234, 0.18)',
  score: 'rgba(244, 241, 234, 0.22)',
  me: '#5cc48f',
  opp: '#f4f1ea',
  ball: '#ffffff',
  shade: 'rgba(15, 13, 10, 0.62)',
  text: '#f4f1ea',
  muted: 'rgba(244, 241, 234, 0.72)',
};
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Draws one frame of the court from this player's point of view: their own paddle is always
 * on the left. `view` = { ball, myPad, oppPad, myScore, oppScore, overlay }.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const scale = this.canvas.width / W;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  draw(view) {
    this.fit();
    const c = this.ctx;
    c.fillStyle = COLORS.court;
    c.fillRect(0, 0, W, H);

    c.fillStyle = COLORS.line;
    for (let y = 8; y < H; y += 28) c.fillRect(W / 2 - 2, y, 4, 14);

    c.fillStyle = COLORS.score;
    c.font = `700 84px ${MONO}`;
    c.textBaseline = 'top';
    c.textAlign = 'right';
    c.fillText(String(view.myScore), W / 2 - 36, 22);
    c.textAlign = 'left';
    c.fillText(String(view.oppScore), W / 2 + 36, 22);

    const top = (y) => Math.round(y - PADDLE_H / 2);
    c.fillStyle = COLORS.me;
    roundRect(c, PADDLE_INSET, top(view.myPad), PADDLE_W, PADDLE_H, 4);
    c.fillStyle = COLORS.opp;
    roundRect(c, W - PADDLE_INSET - PADDLE_W, top(view.oppPad), PADDLE_W, PADDLE_H, 4);

    if (view.ball) {
      c.fillStyle = COLORS.ball;
      c.beginPath();
      c.arc(view.ball.x, view.ball.y, BALL_R, 0, Math.PI * 2);
      c.fill();
    }

    if (view.overlay) this.overlay(view.overlay);
  }

  overlay({ big, small, dim = true }) {
    const c = this.ctx;
    if (dim) {
      c.fillStyle = COLORS.shade;
      c.fillRect(0, 0, W, H);
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (big) {
      c.fillStyle = COLORS.text;
      c.font = `700 ${big.length <= 2 ? 120 : 56}px ${MONO}`;
      c.fillText(big, W / 2, H / 2 - (small ? 24 : 0));
    }
    if (small) {
      c.fillStyle = COLORS.muted;
      c.font = `500 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      c.fillText(small, W / 2, H / 2 + (big ? 50 : 0));
    }
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
  c.fill();
}
