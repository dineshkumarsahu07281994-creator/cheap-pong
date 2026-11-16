# CheapPong architecture

CheapPong is a static website. There is no game server: GitHub Pages serves the files, a
free public broker introduces the two players, and from then on the two browsers talk
directly to each other over WebRTC. One of them (the host) runs the game.

## 1. System overview

```mermaid
flowchart TB
    Static["<b>Static hosting</b><br/>GitHub Pages: index.html, style.css, config.js, js/*<br/>jsDelivr CDN: peerjs 1.5.5"]

    subgraph Match["One match"]
        direction LR
        Host["<b>Browser A: host</b><br/>app.js runs game.js physics"]
        Guest["<b>Browser B: guest</b><br/>app.js predicts the ball"]
        Host <== "WebRTC data channel<br/>the whole game" ==> Guest
    end

    Broker["<b>PeerJS broker</b><br/>0.peerjs.com<br/>matchmaking and signalling only"]
    Ice["<b>Network helpers</b><br/>STUN: Google, Cloudflare<br/>TURN relay: optional, set in config.js"]

    Static -- "page load" --> Host
    Static -- "page load" --> Guest
    Host -. "lobby slot, WebSocket" .-> Broker
    Guest -. "lobby slot, WebSocket" .-> Broker
    Host -. "connection setup" .-> Ice
    Guest -. "connection setup" .-> Ice
```

Dotted lines are only used while connecting. Once the data channel is open, both players
leave the broker, so the broker never sees any game traffic and the lobby slot is free for
the next pair. STUN lets each browser find its public address so they can connect
directly. If a network blocks that (strict NATs, many mobile carriers, offices), the game
traffic has to go through a TURN relay; with none configured, those players can't play
each other.

## 2. Matchmaking: the lobby slot

Everyone tries to claim the same peer ID, `cheappong-v1-main` (or `cheappong-v1-<name>`
with `?lobby=<name>`). The broker gives an ID to only one client at a time, so the first
player to arrive waits in the slot and the next one connects to them.

```mermaid
sequenceDiagram
    autonumber
    participant A as Player A
    participant Broker as PeerJS broker
    participant B as Player B

    A->>Broker: claim ID cheappong-v1-main
    Broker-->>A: open, A now holds the slot
    Note over A: "Waiting for an opponent…"

    B->>Broker: claim ID cheappong-v1-main
    Broker-->>B: error unavailable-id
    B->>Broker: connect with a random ID
    B->>A: connect to cheappong-v1-main (WebRTC, signalled via broker)
    B->>A: hello with protocol version and name
    A->>B: start with name
    Note over A,B: A is the host, B is the guest

    A->>Broker: disconnect, slot is free again
    B->>Broker: disconnect
    Note over A,B: the data channel stays open
```

Failure handling in `js/net.js`:

| Situation | What happens |
| --- | --- |
| Slot holder is already mid-handshake with someone else | It answers `busy` and the newcomer retries |
| Slot holder left before the guest connected (`peer-unavailable`) | The guest tries to take the slot itself |
| Handshake doesn't finish within 10 s | Counted as a failed connection; after 2 the status warns that the network may block direct play |
| A host has 2 guests fail in a row | It gives up the slot for 10–15 s so a reachable player can host |
| More than 15 broker errors | Search stops with "Could not reach the matchmaking service" |
| Protocol version mismatch | The host answers `busy`, so old and new versions never pair |

## 3. During a match

The host is the only referee. It reads its own paddle from the mouse/keyboard, takes the
guest's paddle from the network, steps the physics every frame and sends a snapshot about
30 times a second. The guest only sends its paddle position. Both screens are drawn from
each player's own point of view, so the guest's view is mirrored left to right.

```mermaid
sequenceDiagram
    participant HI as Host input
    participant H as Host app.js + game.js
    participant G as Guest app.js
    participant GI as Guest input

    loop every animation frame on the host
        HI->>H: own paddle y
        H->>H: step() ball, walls, paddles, score
    end

    loop about every 33 ms
        GI->>G: own paddle y
        G->>H: pad with y, only when it moved or every 250 ms
        Note right of H: host moves the guest paddle towards y,<br/>no faster than the legal paddle speed
        H->>G: s snapshot with ball, paddles, score,<br/>phase, event counters, rematch, hidden
        Note left of G: guest predicts the ball from the snapshot<br/>by snapshot age + rtt/2, then blends<br/>out the correction over about 70 ms
    end

    loop every 1 s
        H->>G: ping
        G-->>H: pong
        G->>H: ping
        H-->>G: pong
    end
```

Other messages on the same channel:

| Message | From | Meaning |
| --- | --- | --- |
| `vis` | guest | The guest's tab was hidden or shown. The host pauses the match while either tab is hidden and restarts with a countdown. |
| `rematch` | guest | The guest wants a rematch. The host's own wish and the guest's are both shown in the snapshot (`rm`); when both are set the host starts a new match. |
| `bye` | either | The player clicked Leave or closed the page. The other side wins by forfeit. |

If nothing arrives for 15 seconds, the other player is treated as gone. Sounds (paddle,
wall, point) are played on both sides by comparing the event counters in consecutive
states, so the guest hears the same events as the host.

### Match phases

```mermaid
stateDiagram-v2
    [*] --> countdown: match starts
    countdown --> play: after 3 s, serve
    play --> serve: point scored
    serve --> play: after 1 s, serve to the player who conceded
    play --> over: a player reaches 7
    countdown --> paused: a tab is hidden
    serve --> paused: a tab is hidden
    play --> paused: a tab is hidden
    paused --> countdown: both tabs visible again
    over --> countdown: both players click Rematch
    over --> [*]: Leave or New opponent
    note right of over
        Also reached from any phase when the
        opponent leaves or stops responding
    end note
```

After a pause, a rally that was in flight carries on from where it stopped; if the pause
happened before a serve, the countdown ends with a fresh serve.

## 4. Code layout

```mermaid
flowchart TD
    index["index.html"] --> peerjs["peerjs.min.js<br/>from jsDelivr"]
    index --> config["config.js<br/>optional TURN URL"]
    index --> app["js/app.js<br/>lobby, host loop, guest prediction,<br/>input, UI"]
    app --> net["js/net.js<br/>matchmaking and handshake"]
    app --> game["js/game.js<br/>rules and physics, no DOM"]
    app --> render["js/render.js<br/>canvas drawing"]
    app --> sound["js/sound.js<br/>Web Audio blips"]
    render --> game
    net --> peerjs
    net --> config
    tests["test/game.test.mjs<br/>node --test"] --> game
```

`js/game.js` has no DOM or network code, so the same functions run the real match on the
host, predict the ball on the guest, and are unit-tested in Node.

## Design choices

| Choice | Why | Cost |
| --- | --- | --- |
| Peer-to-peer instead of a WebSocket server | Free to run and nothing to operate; GitHub Pages can only serve static files | Some networks block direct connections without a TURN relay |
| Host-authoritative physics | Only one copy of the truth, so the two players can never disagree about a point | The host's own paddle has no network delay, a small advantage |
| Guest-side prediction | Hides the network delay, so the ball moves smoothly between snapshots | On a last-moment save the guest's ball can briefly be wrong before snapping to the host's |
| Fixed 240 Hz physics sub-steps | The ball can't pass through a paddle, even at top speed or after a slow frame | Slightly more work per frame, negligible for one ball |
| Host limits the guest paddle speed | A modified client can't teleport its paddle onto the ball | Some slack is allowed for bunched-up packets |
