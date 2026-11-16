// Pong rules and physics. No DOM and no networking, so it runs the same in the browser and
// in Node tests. The host runs step() on the one true match state; the guest only calls
// predictBall() to draw the ball between the host's snapshots.
//
// World coordinates: x grows to the right, y grows downwards. Side 0 is the left paddle
// (the host), side 1 the right paddle (the guest). The guest's screen is mirrored so that
// each player sees their own paddle on the left.

export const W = 800;
export const H = 500;
export const PADDLE_W = 12;
export const PADDLE_H = 90;
export const PADDLE_INSET = 24; // gap between the end wall and the back of a paddle
export const BALL_R = 8;
export const PADDLE_SPEED = 900; // px/s, for keyboard control and for chasing the pointer
export const WIN_SCORE = 7;
export const COUNTDOWN_MS = 3000;
export const SERVE_DELAY_MS = 1000;
export const PHASES = ['countdown', 'serve', 'play', 'paused', 'over'];

const SERVE_SPEED = 380;
const SPEEDUP = 1.05; // per paddle hit
const MAX_SPEED = 1000;
const MAX_BOUNCE_ANGLE = (55 * Math.PI) / 180;
const MAX_SERVE_ANGLE = (30 * Math.PI) / 180;
const STEP_S = 1 / 240; // ~4 px per step at top speed, far less than a paddle's width

export const LEFT_FACE = PADDLE_INSET + PADDLE_W;
export const RIGHT_FACE = W - PADDLE_INSET - PADDLE_W;
const PAD_MIN = PADDLE_H / 2;
const PAD_MAX = H - PADDLE_H / 2;

export function clampPad(y) {
  return Number.isFinite(y) ? Math.min(PAD_MAX, Math.max(PAD_MIN, y)) : H / 2;
}

function centreBall() {
  return { x: W / 2, y: H / 2, vx: 0, vy: 0 };
}

export function ballMoving(ball) {
  return ball.vx !== 0 || ball.vy !== 0;
}

/** `receiver` is the side the first serve travels towards. */
export function newMatch(receiver = Math.random() < 0.5 ? 0 : 1) {
  return {
    pads: [H / 2, H / 2],
    score: [0, 0],
    ball: centreBall(),
    phase: 'countdown',
    phaseLeft: COUNTDOWN_MS,
    receiver,
    firstReceiver: receiver,
    winner: null,
    // Event counters: the guest compares them between snapshots to play sounds.
    hits: 0,
    walls: 0,
    points: 0,
  };
}

/**
 * Moves the ball by `dt` seconds, bouncing off the walls and the paddles at `pads`.
 * Mutates `ball`. Returns { hit, walls, goal }: `hit` is the side whose paddle hit the ball
 * (or -1), `goal` the side that scored (or -1). Stops at the first goal.
 */
export function moveBall(ball, pads, dt) {
  const out = { hit: -1, walls: 0, goal: -1 };
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(STEP_S, left);
    left -= h;
    const px = ball.x;
    const py = ball.y;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;

    if (ball.y < BALL_R) {
      ball.y = 2 * BALL_R - ball.y;
      ball.vy = Math.abs(ball.vy);
      out.walls++;
    } else if (ball.y > H - BALL_R) {
      ball.y = 2 * (H - BALL_R) - ball.y;
      ball.vy = -Math.abs(ball.vy);
      out.walls++;
    }

    // A paddle only counts if the ball crossed its face during this step.
    if (ball.vx < 0 && px - BALL_R >= LEFT_FACE && ball.x - BALL_R < LEFT_FACE) {
      if (bounce(ball, 0, pads[0], px, py)) out.hit = 0;
    } else if (ball.vx > 0 && px + BALL_R <= RIGHT_FACE && ball.x + BALL_R > RIGHT_FACE) {
      if (bounce(ball, 1, pads[1], px, py)) out.hit = 1;
    }

    if (ball.x + BALL_R < 0) out.goal = 1;
    else if (ball.x - BALL_R > W) out.goal = 0;
    if (out.goal !== -1) break;
  }
  return out;
}

function bounce(ball, side, padY, px, py) {
  const contactX = side === 0 ? LEFT_FACE + BALL_R : RIGHT_FACE - BALL_R;
  const t = (contactX - px) / (ball.x - px);
  const yAtContact = py + (ball.y - py) * t;
  const reach = PADDLE_H / 2 + BALL_R;
  const offset = (yAtContact - padY) / reach;
  if (Math.abs(offset) > 1) return false;

  // Where the ball meets the paddle sets the new angle; every hit speeds it up a little.
  const speed = Math.min(MAX_SPEED, Math.hypot(ball.vx, ball.vy) * SPEEDUP);
  const angle = offset * MAX_BOUNCE_ANGLE;
  const dir = side === 0 ? 1 : -1;
  ball.vx = dir * speed * Math.cos(angle);
  ball.vy = speed * Math.sin(angle);
  ball.x = contactX;
  ball.y = Math.min(H - BALL_R, Math.max(BALL_R, yAtContact));
  return true;
}

function launch(s, rng) {
  const angle = (rng() * 2 - 1) * MAX_SERVE_ANGLE;
  const dir = s.receiver === 0 ? -1 : 1;
  s.ball = {
    x: W / 2,
    y: H / 2 + (rng() - 0.5) * H * 0.4,
    vx: dir * SERVE_SPEED * Math.cos(angle),
    vy: SERVE_SPEED * Math.sin(angle),
  };
}

function scorePoint(s, side) {
  s.score[side]++;
  s.points++;
  s.receiver = 1 - side; // the next serve goes to the player who just conceded
  s.ball = centreBall();
  if (s.score[side] >= WIN_SCORE) {
    s.phase = 'over';
    s.winner = side;
  } else {
    s.phase = 'serve';
    s.phaseLeft = SERVE_DELAY_MS;
  }
}

/** Advances the match by `dtMs` milliseconds. Paddle positions are read from `s.pads`. */
export function step(s, dtMs, rng = Math.random) {
  if (s.phase === 'countdown' || s.phase === 'serve') {
    s.phaseLeft -= dtMs;
    if (s.phaseLeft <= 0) {
      s.phaseLeft = 0;
      if (!ballMoving(s.ball)) launch(s, rng); // a paused rally just carries on
      s.phase = 'play';
    }
    return;
  }
  if (s.phase !== 'play') return;

  const res = moveBall(s.ball, s.pads, dtMs / 1000);
  s.walls += res.walls;
  if (res.hit !== -1) s.hits++;
  if (res.goal !== -1) scorePoint(s, res.goal);
}

export function pause(s) {
  if (s.phase !== 'over' && s.phase !== 'paused') s.phase = 'paused';
}

export function resume(s) {
  if (s.phase !== 'paused') return;
  s.phase = 'countdown';
  s.phaseLeft = COUNTDOWN_MS;
}

/** Where `ball` will be after `seconds`, given paddles at `pads`. Does not mutate `ball`. */
export function predictBall(ball, pads, seconds) {
  const b = { ...ball };
  if (seconds > 0 && ballMoving(b)) moveBall(b, pads, seconds);
  return b;
}
