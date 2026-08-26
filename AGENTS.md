<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Sea Battle — architecture

Golden-hour naval combat in 3D. Two online modes share one match engine and one
3D theater: **duel** (1v1) and **duo** (2v2, teams of two). Solo play runs the
same engine client-side against a simple AI. There are no sockets — every
online interaction is a plain App Router route handler, synced by long-polling.

## The invariant

`lib/game/match.ts` is the *only* place game rules exist. It is a pure,
JSON-serializable state machine: given a state and an action it returns a new
state plus events, nothing else. The server runs it authoritatively (persisted
in Redis); solo play runs the identical module in the browser with an AI in the
extra seat(s). `lib/game/adapter.ts`'s `MatchAdapter` is the contract that lets
`components/GameShell.tsx` (the shell: 3D scene + HUD) stay ignorant of which
is which — it only ever consumes `MatchView` snapshots.

Never duplicate a rule outside `match.ts`. If a check needs to move (e.g. "is
this a friendly board"), it belongs in `fire()`, not in a route handler or the
client.

## Seats, teams, modes

```
Mode  = 'duel' | 'duo'
Side  = 'a' | 'b' | 'c' | 'd'      — SEATS['duel'] = [a,b], SEATS['duo'] = [a,b,c,d]
Team  = 'red' | 'blue'
```

- **duel**: seat `a` is always Team Red, seat `b` always Team Blue, assigned at
  join. No lobby step — the battle starts the instant both seats are filled and
  both fleets are deployed, exactly as the original 1v1 behaved.
- **duo**: teams are chosen in a real lobby (`setTeam`/`setReady` actions, gated
  by `rules.lobbyReady`). Deployment cannot begin until all four seats are
  filled, teamed 2-and-2, and every seat has readied up.
- **Turn order** is frozen once when the battle starts (`buildTurnOrder`) and
  never reshuffled: duel is `[a, b]`; duo interleaves by team in seat order —
  Red-seat-1, Blue-seat-1, Red-seat-2, Blue-seat-2. `advanceTurn` walks that
  frozen order forward, skipping eliminated or left seats.
- **Targeting is free**: `fire(state, side, target, idx, now)` lets the acting
  player choose *which* living enemy seat to shoot at. The only server-side
  constraints are: it's your turn, the target is a real occupied enemy seat
  (not a teammate), and that seat isn't already eliminated.
- **Elimination vs. victory**: a seat is `eliminated` once its whole fleet is
  sunk (skipped by `advanceTurn` from then on, but the match continues). A
  *team* wins once every seat on the opposing team is eliminated or has left.
- **A walkout mid-battle** eliminates that seat immediately; the match only
  ends if that seat's whole team is now gone. A walkout mid-deploy drops the
  room back to `lobby` and clears everyone's `ready` — but keeps any fleets
  already committed, so the players who were ready don't lose their work.

## The redacted view (`MatchView`)

`viewFor(state, viewerSide)` produces what one player is allowed to know:
`view.seats[]`, one `SeatView` per seat, each tagged with a `relation` —
`'self' | 'ally' | 'foe'` — relative to the viewer.

- `fleet` (hull positions) is included only for `self` and `ally` — allies
  share full vision of each other's boards. This is the one genuinely secret
  field.
- `board` (the peg marks on that seat's own grid) is included for *every*
  seat, foe included. This looks like it should be secret but isn't: whoever
  is entitled to know a mark already does — the shooter's whole team made it,
  and the board's own team can already see their own pegs. Broadcasting it
  costs nothing and simplifies the client.
- `revealed` (sunk hulls) is the *only* way a foe's cells are ever disclosed,
  exactly once, the moment a ship goes down.
- Seat tokens never appear in any `MatchView`, ever.

If you change `viewFor`, re-run the fog-of-war check: read the raw JSON from
`GET /api/rooms/:id` as a foe and confirm no un-sunk enemy cell or token
appears anywhere in the payload. The type system will not catch a redaction
bug — only reading the wire format will.

## Persistence and transport (`lib/net/`)

- **Storage**: `lib/net/store.ts` abstracts Upstash Redis (production) behind
  a `Store` interface, with a process-local fallback for solo dev. `GET
  /api/health` reports which one is live.
- **One room = one JSON blob** at `sb:room:<CODE>`, gated by a `schema` field
  (currently `2`) — `loadRoom` discards any blob from an older schema rather
  than feed it to rules that don't understand its shape; it simply ages out of
  its 3h TTL.
- **Writes** go through `mutateRoom` in `lib/net/rooms.ts`: acquire a short
  Redis lock → load → run the pure mutator from `match.ts` → save → release.
  The lock only matters for joins and simultaneous deploys; turn ownership
  already serializes shots.
- **Quick-match queues are split by mode** (`sb:queue:duel`, `sb:queue:duo`) —
  a duo room must never be handed to someone quick-matching for a duel.
- **Transport is long-polling, not sockets.** `GET /api/rooms/:id?wait=1&v=`
  holds the connection open (`waitForVersion`) until the room's `version`
  moves past what the client already has, then returns. Every mutating route
  bumps `version`. The client (`lib/net/useOnlineMatch.ts`) loops this
  indefinitely; its own POST responses land immediately since the response
  *is* the new view.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/rooms` | Open a room (`mode: 'duel' \| 'duo'`), seat the caller as `a` |
| `POST /api/rooms/:id/join` | Take a free seat, or resume yours with a token |
| `POST /api/rooms/:id/team` | Lobby-only, duo-only: choose Red/Blue |
| `POST /api/rooms/:id/ready` | Lobby-only: ready up; starts deployment once everyone has |
| `POST /api/rooms/:id/deploy` | Commit a fleet (re-validated server-side) |
| `POST /api/rooms/:id/fire` | Resolve a shot against a chosen `target` seat |
| `POST /api/rooms/:id/rematch` | Every present seat must ask before the boards reset |
| `POST /api/rooms/:id/leave` | Free the seat |
| `GET /api/rooms/:id` | Redacted snapshot + unseen events; `?wait=1` long-polls |
| `POST /api/matchmake` | Pair with whoever is already waiting for the same mode, else host |

## The 3D theater (`lib/game/scene.ts`)

`SeaBattleScene` is a plain TypeScript class — no React, no game rules, raw
Three.js. It renders a **slot-keyed** table, not a seat-keyed one: slots are
always viewer-relative —

```
Slot = 'you' | 'ally' | 'foeA' | 'foeB'
```

A duel or solo match only ever uses `you` and `foeA`, positioned exactly as
the original two-board table (`POSE_2`). A duo match uses all four, arranged
in a 2×2 "war table" with teams in rows — your row near the camera, the enemy
row beyond it (`POSE_4`). `GameShell.tsx` is the *only* place that knows how to
map a match's absolute `Side` onto a viewer-relative `Slot` (`assignSlots` /
`slotForSide` / `sideForSlot`) — the scene never learns which seat is which,
only which slot.

Per-board affordances (all keyed by `Slot`, set via `scene.setRoster(specs)`):
a team-coloured rail on the brass frame, a canvas-texture nameplate (built the
same way as the existing A–J/1–10 edge labels), a fog blanket that only shows
on `foe`-relation boards, and a light column that follows whichever slot is
currently acting (`setActingSlot`). Picking is multi-board: `setPickable(slots)`
tells the scene which boards may be raycast right now (`['you']` while
deploying, the living enemy slots on your turn), and `onHover`/`onPick` report
`{ slot, idx }` instead of a bare index.

`playShot({ from, to, idx, hit, sunk })` fires a shell from the rim of the
`from` board facing the `to` board — generalized from the old hardcoded
"opposite board's centre cell", so any pairing (including a shot between two
players you don't control) arcs correctly.

## Verification

No test framework — this project is verified by running it. Before any change
that touches `match.ts`, `scene.ts`, or the route handlers:

1. `npx tsc --noEmit` and `bun run lint` clean.
2. **1v1 must stay byte-for-byte the same experience.** Two tabs, quick match,
   full battle, rematch, mid-battle leave — nothing here should feel different
   from before duo mode existed.
3. **2v2** in four separate browser profiles (the seat token lives in
   `localStorage`, so four tabs in one profile fight over seats): team-lock
   enforcement, ready-gating, the Red→Blue→Red→Blue rotation, a friendly-fire
   attempt rejected server-side (not just hidden in the UI), elimination
   skipping a seat in rotation, and a 2v1 continuation after a walkout.
4. The fog-of-war check described above.
