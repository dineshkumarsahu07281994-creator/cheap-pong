// Physics tests: `node --test test/` from the project folder (Node 18+, no installs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/game.js';

const fixedRng = () => 0.5; // serve straight along the middle

function playing(ball, pads = [P.H / 2, P.H / 2]) {
  const s = P.newMatch(0);
  s.phase = 'play';
  s.ball = { ...ball };
  s.pads = pads;
  return s;
}

test('countdown ends with a serve towards the receiver', () => {
  const s = P.newMatch(1);
  P.step(s, P.COUNTDOWN_MS - 1, fixedRng);
  assert.equal(s.phase, 'countdown');
  P.step(s, 2, fixedRng);
  assert.equal(s.phase, 'play');
  assert.ok(s.ball.vx > 0, 'serve goes right, towards side 1');
});

test('ball bounces off a paddle it meets and speeds up', () => {
  const s = playing({ x: 100, y: 250, vx: -400, vy: 0 });
  for (let i = 0; i < 60; i++) P.step(s, 16);
  assert.ok(s.ball.vx > 0, 'reflected');
  assert.equal(s.hits, 1);
  assert.ok(Math.abs(s.ball.vx) > 400);
  assert.deepEqual(s.score, [0, 0]);
});

test('hitting the paddle edge sends the ball off at an angle', () => {
  const s = playing({ x: 100, y: 250 + 40, vx: -400, vy: 0 });
  for (let i = 0; i < 30; i++) P.step(s, 16);
  assert.ok(s.ball.vy > 0, 'lower edge deflects downwards');
});

test('a missed ball scores for the other side and the next serve goes to the loser', () => {
  const s = playing({ x: 100, y: 250, vx: -400, vy: 0 }, [60, P.H / 2]);
  for (let i = 0; i < 60 && s.phase === 'play'; i++) P.step(s, 16);
  assert.deepEqual(s.score, [0, 1]);
  assert.equal(s.phase, 'serve');
  assert.equal(s.receiver, 0);
  P.step(s, P.SERVE_DELAY_MS + 1, fixedRng);
  assert.ok(s.ball.vx < 0, 'served to side 0');
});

test('walls reflect the ball and keep it on the court', () => {
  const s = playing({ x: 400, y: 20, vx: 0.0001, vy: -600 });
  for (let i = 0; i < 20; i++) {
    P.step(s, 16);
    assert.ok(s.ball.y >= P.BALL_R && s.ball.y <= P.H - P.BALL_R);
  }
  assert.ok(s.walls >= 1);
});

test('no tunnelling through a paddle at top speed, even with a long frame', () => {
  for (const dt of [16, 50, 100]) {
    const s = playing({ x: 300, y: 250, vx: -1000, vy: 0 });
    for (let i = 0; i < 20 && s.ball.vx < 0; i++) P.step(s, dt);
    assert.ok(s.ball.vx > 0, `bounced with dt=${dt}`);
  }
});

test('speed is capped', () => {
  const s = playing({ x: 400, y: 250, vx: -1000, vy: 0 });
  for (let i = 0; i < 2000; i++) P.step(s, 16); // paddles both centred: endless rally
  assert.ok(s.hits > 10);
  assert.ok(Math.hypot(s.ball.vx, s.ball.vy) <= 1000 + 1e-6);
});

test('first to WIN_SCORE wins and the match stops', () => {
  const s = P.newMatch(0);
  s.score = [P.WIN_SCORE - 1, 3];
  s.phase = 'play';
  s.ball = { x: 700, y: 250, vx: 600, vy: 0 };
  s.pads = [P.H / 2, 60]; // right paddle out of the way
  for (let i = 0; i < 60 && s.phase === 'play'; i++) P.step(s, 16);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 0);
  const before = JSON.stringify(s);
  P.step(s, 1000);
  assert.equal(JSON.stringify(s), before);
});

test('pause freezes a rally; resume counts down and the rally carries on', () => {
  const s = playing({ x: 400, y: 250, vx: 300, vy: 100 });
  P.pause(s);
  P.step(s, 500);
  assert.equal(s.ball.x, 400);
  P.resume(s);
  assert.equal(s.phase, 'countdown');
  P.step(s, P.COUNTDOWN_MS + 1, () => 0);
  assert.equal(s.phase, 'play');
  assert.deepEqual([s.ball.vx, s.ball.vy], [300, 100], 'same ball, not a new serve');
});

test('predictBall matches the real simulation and does not mutate its input', () => {
  const ball = { x: 400, y: 100, vx: -700, vy: -300 };
  const pads = [100, 250];
  const predicted = P.predictBall(ball, pads, 0.5);
  assert.equal(ball.x, 400);
  const s = playing(ball, pads);
  P.step(s, 500);
  assert.ok(Math.abs(predicted.x - s.ball.x) < 1e-6 && Math.abs(predicted.y - s.ball.y) < 1e-6);
});

test('clampPad keeps the paddle on the court and rejects junk', () => {
  assert.equal(P.clampPad(-50), P.PADDLE_H / 2);
  assert.equal(P.clampPad(9999), P.H - P.PADDLE_H / 2);
  assert.equal(P.clampPad(NaN), P.H / 2);
});
