---
date: 2026-04-24
title: Real Multiplayer — Lobby, Parties, Queue, Stats
status: approved
---

# Real Multiplayer Design

## Goal
Make Pirates BR genuinely playable by multiple humans in one match, with private parties, public matchmaking queue, and persistent stats. The current server is single-match, single-human; every new connection nukes the world. We're flipping that.

## Architecture

### Match abstraction
Extract all game-loop/state from `GameServer` into a `Match` class. Each match owns its own `GameState`, systems (Physics/Weapon/Storm/Island/Trade/Bots), tick interval, and connected client set.

`GameServer` becomes the orchestrator:
- `clients: Map<clientId, ClientSession>` — every WS, with state `menu | party | queue | in_match`
- `parties: Map<code, Party>` — private lobbies
- `queue: ClientSession[]` — public matchmaking queue with one timer
- `matches: Map<matchId, Match>` — live games
- `stats: StatsStore` — persistent JSON-backed stats by lowercased name

### Lobby protocol (new NetMsgs)

Client → Server:
- `hello { name? }` — sent on connect; server responds with `welcome` + cached stats
- `set_name { name }`
- `create_party {}`
- `join_party { code }`
- `leave_party {}`
- `update_party_settings { botFill }`
- `start_match {}` — host only
- `queue_join {}`
- `queue_leave {}`
- `return_to_menu {}` — after match end

Server → Client:
- `welcome { clientId, stats }`
- `lobby_update { code, hostId, members: [{id,name,isHost}], botFill, canStart }`
- `lobby_left {}` — when leaving / kicked
- `lobby_error { reason }`
- `queue_update { inQueue, needed, secondsRemaining }`
- `match_start { matchId, snapshot, playerId, shipId }`
- `match_ended { winner, stats }`
- `stats_update { stats }`

Existing game messages (`state_snapshot`, `player_input`, etc.) operate within a Match scope; server routes by `client.matchId`.

### Party flow
1. Connect → menu state.
2. `create_party` → server generates 4-char code (A–Z digits, no I/O/0/1), sets host, returns `lobby_update`.
3. `join_party { code }` → if found and < 16 members → join, broadcast `lobby_update`.
4. Host adjusts bot fill (0–14) → broadcast.
5. Host `start_match` → spawn Match, all members get `match_start`, transition out of menu.
6. Disconnect/leave: remove member; if host leaves, promote next; if empty, destroy party.

### Public queue
- `queue_join` adds session to queue.
- Tick checks queue: start match when queue ≥ 2 humans, OR after 15s with ≥ 1 human.
- Bots fill remaining slots up to 8.
- Single shared 15s timer that resets on first joiner.

### Stats persistence
File: `data/stats.json` (gitignored).

```ts
interface PlayerStats {
  name: string;          // display name (case preserved)
  kills: number;
  deaths: number;
  wins: number;
  matchesPlayed: number;
  totalGold: number;
  bestPlacement: number; // lowest = best (1 = winner)
}
```

Keyed by `name.toLowerCase()`. Loaded on boot, written debounced (1s after change).

On `match_ended`, server tallies each human and updates stats, sends `stats_update` to each client.

### Client UI
HTML-based menu overlay sitting above the canvas:

**Main menu:** title, name input, PLAY button (queue), Create Party / Join Party (code input), stats strip (kills, wins, matches).

**Lobby screen:** code with copy button, roster list w/ host ★, bot-count slider (host only), START VOYAGE (host), LEAVE.

**Queue screen:** "Searching the seas… 3/8 pirates · 0:12", CANCEL.

**End-of-match flow:** existing death/win screens get "RETURN TO PORT" button → sends `return_to_menu`, server detaches client from match.

### Match isolation
Players in different matches can't see/affect each other. Snapshot broadcast loop iterates `match.clients`, not `server.clients`. Player input only routed to its match.

### Bot ownership
Bots belong to a match — when match ends, bots are GC'd with the match.

## Non-goals
- Authentication / accounts — name-based only
- Ranked / ELO
- Persistent friends list
- Chat (trivial future addition)
- Spectator mode

## Risks
- Many concurrent matches on one Node process: fine for prototype scale.
- Stats race on simultaneous match-end writes: solved by debounce + atomic write (`writeFile` to `.tmp` then rename).
- Code collision: regenerate on conflict, log if 5 retries fail.

## Implementation order
1. Server: extract Match class
2. Server: lobby protocol (parties, queue)
3. Server: stats persistence
4. Client: NetworkClient lobby methods
5. Client: menu/lobby/queue UI
6. Smoke test with 2 browser tabs
