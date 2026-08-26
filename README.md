# Sea Battle

Golden-hour naval combat in 3D. Deploy a fleet, then duel another commander over
a shared room code — or drill against the machine.

Built on Next.js (App Router) with Tailwind CSS v4 and Three.js. Every online
interaction goes through App Router route handlers; there are no sockets and no
third-party realtime service.

## Getting started

```bash
bun install
vercel env pull .env.local   # Upstash Redis credentials for online play
bun run dev
```

Open http://localhost:3000.

Without Redis credentials the app falls back to a process-local store so solo
play and a single-machine online test still work. `GET /api/health` reports which
store is live, and the lobby shows a warning when it is not Redis. In production
the app refuses to start online play without credentials rather than silently
splitting rooms across function instances.

## How online play works

The match rules live in one place, `lib/game/match.ts`, as a pure,
JSON-serializable state machine. The server runs it as the sole authority; solo
play runs the very same module in the browser with an AI in the second seat. The
game shell cannot tell the two apart — it just consumes snapshots from a
`MatchAdapter`.

| Route | Purpose |
| --- | --- |
| `POST /api/rooms` | Open a room and take the first seat |
| `POST /api/rooms/:id/join` | Take the free seat, or resume yours with a token |
| `POST /api/rooms/:id/deploy` | Commit a fleet (re-validated server-side) |
| `POST /api/rooms/:id/fire` | Resolve a shot — the only place hit/miss is decided |
| `POST /api/rooms/:id/rematch` | Both sides must ask before the boards reset |
| `POST /api/rooms/:id/leave` | Free the seat; a walkout forfeits a live battle |
| `GET /api/rooms/:id` | Redacted snapshot + unseen events; `?wait=1` long-polls |
| `POST /api/matchmake` | Pair with whoever is already waiting, else host |
| `GET /api/health` | Which store is backing online play |

**Fog of war.** A player's snapshot never contains the opponent's un-sunk ship
cells, and never contains either player's seat token. Enemy positions are
revealed only through the `sunk` payload of a shot event — which is also how the
client learns where to place and sink the hull it just destroyed.

**Transport.** `GET /api/rooms/:id?wait=1&v=<version>` holds the request open for
up to 25 seconds, polling Redis on a ramp (250ms for the first 3s, then 600ms,
then 1.5s) and returning the moment the room's version moves. A client's own
POST bumps the version, so its in-flight poll returns immediately with the same
events — the client de-duplicates by sequence number.

Each held poll costs on the order of 15–20 Redis reads. If you outgrow the
Upstash free tier, widen the ramp in `pollInterval` (`lib/net/rooms.ts`).

**Concurrency.** Writes go through `mutateRoom`, a read-modify-write under a
short Redis lock (`SET NX PX`, released with a compare-and-delete Lua script).
The read path never writes, so a long poll can never clobber a move.

**Seats.** A seat is a token in `localStorage`, not a cookie session. Refreshing
or losing the connection resumes the same seat; only pressing *Leave* gives it
up. `claimSeat` de-duplicates in-flight joins so a double-mounted effect cannot
occupy both seats.

## Layout

```
app/api/            route handlers (the entire online surface)
app/page.tsx        the port: quick match, private room, join by code, solo
app/play/[roomId]/  an online seat
app/solo/           drill against the machine
lib/game/rules.ts   board, fleet, placement validation
lib/game/match.ts   the isomorphic state machine
lib/game/scene.ts   the Three.js theater (no React, no game rules)
lib/game/ai.ts      the solo opponent
lib/net/            store, room persistence, client, long-poll hook
components/         the game shell and HUD
```

## Controls

Drag to orbit · wheel or pinch to zoom · `R` rotates the ship in hand · `Space`
fires at the hovered cell.

## Deploying

The project deploys to Vercel as-is. Provision Upstash Redis from the
Marketplace (`vercel integration add upstash/upstash-kv`) and the
`KV_REST_API_URL` / `KV_REST_API_TOKEN` variables are injected automatically;
`UPSTASH_REDIS_REST_*` names are also accepted.
