# CheapPong

Free online Pong against a random opponent. A static website: no accounts, no ads, no game
server. Built on the same matchmaking as CheapChess.

## How it works

Matchmaking uses the free public PeerJS broker. Everyone races to claim one peer ID (the
"lobby slot"). The first player holds it and waits; the next player can't claim it, so they
connect to the holder instead. Once paired, both leave the broker and play over a direct
WebRTC data channel.

Pong is real-time, so one browser has to be the referee. The player who held the lobby slot
becomes the **host**: their browser runs the ball physics (`js/game.js`) and sends the match
state about 30 times a second. The **guest** sends only their paddle position. To hide the
network delay, the guest predicts the ball forward from each snapshot (including bounces off
the walls and both paddles) and smoothly blends in corrections. Each player sees their own
paddle on the left, in green.

Other rules: first to 7 points; the ball speeds up a little on every paddle hit; where the
ball meets the paddle sets its angle; after a point, the ball is served towards the player
who conceded. The game pauses while either player has switched to another tab. If the
opponent leaves mid-match you win by forfeit.

Controls: mouse or finger on the court, or ↑ ↓ / W S.

## Files

```
index.html  style.css  config.js     the page and optional settings
js/net.js      matchmaking (lobby slot, handshake, STUN/TURN)
js/game.js     rules and physics, no DOM (shared by host and guest)
js/app.js      lobby, host loop, guest prediction, input, UI
js/render.js   canvas drawing
js/sound.js    Web Audio blips (mute button in game)
test/          physics tests and a two-player test harness
```

## Run it locally

Any static file server works, for example `python3 -m http.server 8000`, then open
http://localhost:8000 in two browser windows and click Play in both. Use
`?lobby=anything` to get a private queue for testing.

## Put it online (GitHub Pages, free)

Same as CheapChess: create a public repo (e.g. `cheap-pong`), upload these files keeping the
`js/` folder, then Settings → Pages → Deploy from branch → `main` / root. The `test/` folder
is optional.

## Tests

```
node --test test/game.test.mjs          # physics: bounces, scoring, speed cap, no tunnelling, pause
python3 test/build-harness.py > h.html  # both players in one page with a fake PeerJS
```

The harness uses `test/fake-peer.js` (Web Locks for peer IDs, BroadcastChannel as the wire,
40 ms simulated latency each way) and turns on `window.CHEAPPONG_AUTOPILOT` so both paddles
play themselves. Load it as the `srcdoc` of two iframes on one page.

## Known limits

- Players behind strict NATs (some mobile carriers, offices) can't connect directly. Set a
  TURN relay in `config.js`; a relay adds latency, which matters more for Pong than chess.
- The host has a small advantage: their own paddle has no network delay. With good
  connections (under ~100 ms ping) this is hard to notice.
- The guest's view can briefly disagree with the host on a last-moment save; the host's
  decision wins and the guest's ball snaps to it.
