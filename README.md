# Poker

A play-money Texas Hold'em web app. pnpm workspaces + Turborepo.

It plays, and it keeps the books. Four people can sign in, sit at the same table
and play hand after hand: the rules engine (`packages/engine`), phone-number
login and live tables (`apps/server`), and the web client (`apps/web`) are wired
together over a socket, and `apps/e2e` drives four real browsers through it to
prove it. Every hand is written down, replayable, and provably dealt from a deck
the table committed to before it saw a card.

## Requirements

- Node **22 or newer** (`node -v`)
- pnpm 9+ — `npm i -g pnpm`, or `corepack enable pnpm`

## Getting started

```bash
pnpm install
cp .env.example .env      # Windows: copy .env.example .env
pnpm --filter @poker/server db:migrate   # needs Postgres running
pnpm dev
```

### Without a database

Set `AUTH_STORE=memory` in `.env` and skip the migration. Accounts, sessions and
one-time codes are held in the server process and die with it, which is a fine
trade for a laptop and a disaster for a real table — so it is refused outright
when `NODE_ENV=production`.

```bash
AUTH_STORE=memory pnpm dev
```

Auth against Postgres needs a Postgres and a Redis. With Docker:

```bash
docker run -d --name poker-pg -p 5432:5432 -e POSTGRES_USER=poker -e POSTGRES_PASSWORD=poker -e POSTGRES_DB=poker postgres:17
docker run -d --name poker-redis -p 6379:6379 redis:7
```

With `SMS_PROVIDER=console` (the default) the login code is printed to the
server console, so no SMS account is needed to sign in locally.

- Web: <http://localhost:3000>
- Server: <http://localhost:4000> — health check at `/health`

`pnpm dev` starts the web app and the game server together, and watch-builds
`packages/shared` and `packages/engine` behind them, so a change in a package
reaches both apps without a restart.

The web app and the engine boot with no `.env` at all. The server's auth routes
need `DATABASE_URL`, `REDIS_URL` and the two JWT secrets, and say so by name at
boot if any is missing.

## Scripts

Run from the repo root; Turborepo fans each one out in dependency order.

| Command                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                          | web + server + package watch-builds                  |
| `pnpm build`                        | builds every workspace (`shared` and `engine` first) |
| `pnpm test`                         | Vitest in `packages/engine` and `apps/server`        |
| `pnpm typecheck`                    | `tsc --noEmit` in every workspace                    |
| `pnpm lint`                         | ESLint across the repo, one root config              |
| `pnpm format`                       | Prettier write (`pnpm format:check` to verify)       |
| `pnpm clean`                        | removes build output                                 |
| `pnpm --filter @poker/e2e test:e2e` | four browsers, real servers (see below)              |

Scope a task to one workspace with `--filter`:

```bash
pnpm --filter @poker/engine test
pnpm --filter @poker/server dev
pnpm --filter @poker/engine test:watch
```

## Workspaces

| Path               | Package           | Purpose                                                                                                                                                |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`  | `@poker/shared`   | TypeScript types and zod schemas shared by client and server. Only runtime dependency is zod.                                                          |
| `packages/engine`  | `@poker/engine`   | The poker rules, as pure functions. No I/O, no network, no Node built-ins except `node:crypto` behind the injected `Rng` interface. Zero dependencies. |
| `apps/server`      | `@poker/server`   | Node 22 + Fastify + Socket.IO. The only thing that knows the deck.                                                                                     |
| `apps/web`         | `@poker/web`      | Next.js 15 App Router, React 19, Tailwind v4.                                                                                                          |
| `apps/e2e`         | `@poker/e2e`      | Playwright. Starts both servers for real and drives four browsers through a hand.                                                                      |
| `tooling/tsconfig` | `@poker/tsconfig` | Shared strict TypeScript bases (`base`, `library`, `node`, `nextjs`).                                                                                  |

Dependencies point one way: `web -> shared`, `server -> engine -> shared`.

## Environment

`.env.example` lists every variable the app needs. Copy it to `.env` — which is
gitignored — and fill in what you use. `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`
and `JWT_REFRESH_SECRET` are required for login; the two secrets must differ.
`SMS_PROVIDER` picks the gateway (`console`, `msg91`, `twilio`) and only the
console one works without credentials.

Generate a secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## Auth

Phone number is the identity: mandatory, unique, E.164. Email is optional.

| Endpoint                 | What it does                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `POST /auth/otp/request` | Sends a six-digit code. Rate limited per number and per address. |
| `POST /auth/otp/verify`  | Checks it, creates the account on first sight, starts a session. |
| `POST /auth/profile`     | Sets the display name (and optional email) a new account needs.  |
| `POST /auth/refresh`     | Rotates the refresh cookie and issues a new access token.        |
| `POST /auth/logout`      | Revokes the session.                                             |
| `GET  /auth/me`          | The signed-in account.                                           |

The code is stored only as an argon2 hash, in Redis, for five minutes, with five
attempts. Access tokens last 15 minutes; the refresh token lives 30 days in an
httpOnly cookie and is rotated on every use — presenting one that was already
rotated away revokes the whole family and forces a fresh login.

A new account has no display name, so `profileComplete` is false until
`/auth/profile` is called. That flag is what will gate joining a table.

## Tables

A table lives in memory on the server: `TableRegistry` maps a six-character code
to a `TableRuntime`, and the runtime owns one `TableState`, a queue that keeps
every change to it single-file, and the action clock. Nothing is persisted yet,
so a restart clears the tables.

Clients connect a socket with their access token in the handshake, then speak in
acknowledged events: `table:create`, `table:join`, `table:sit`, `table:leave`,
`player:action`, `player:ready`, `chat:send`, `state:resync`. The server answers
with `state:sync` (whole state), `state:patch` (deltas), `action:prompt`,
`hand:result`, `table:error`, and — to one socket alone — `hand:dealt`. Every
state message carries a version that only goes up.

The action clock is the server's: `deadlineTs` is absolute epoch milliseconds, so
a client with a wrong clock still gets the same thirty seconds. When it runs out
the server checks if checking is free and folds if it is not.

### The one rule

`redactFor(state, viewerUserId)` in `src/table/redact.ts` is the only function
that turns table state into something a client may see, and `src/table/
broadcast.ts` is the only file that sends what it returns. The deck never leaves
(clients get a count), and a seat's hole cards go only to that seat until a
showdown makes them public.

`test/realtime-no-leak.test.ts` is the test that matters most in this repo: four
clients play a hand over real sockets, every payload every one of them receives
is kept, and each stream is replayed to prove that no client ever held a card
that was not theirs at that moment. `test/table-redact.test.ts` guards the shape
of the rule itself — that exactly one file calls `redactFor`, and exactly one
file emits table state.

## The web client

`apps/web` is a Next.js App Router client: five routes (`/`, `/auth/verify`,
`/auth/profile`, `/lobby`, `/table/[code]`), Tailwind v4, and one Zustand store.

The store is fed **only** by socket events. It holds what `state:sync` and
`state:patch` said and nothing else — no legal-action logic, no pot maths, no
hand evaluation. `lib/store/patch.ts` transcribes each engine event into the
last whole state the server sent, and asks for a fresh one rather than guessing
whenever it meets an event it cannot apply faithfully. The one deliberate piece
of optimism is that the action bar disables itself the instant it is clicked,
pending the server's acknowledgement.

The felt places up to nine seats on an ellipse with the viewer pinned to
bottom-centre, so a player's own seat is in the same place at every table.
Portrait works down to 360px, where the action bar becomes a fixed bottom sheet
with 44px targets. Every action is a real `<button>`, and an `aria-live` region
reads the hand out — "Naman raises to 400" — from the same strings the hand log
shows.

### Fixtures

The client runs with no server at all:

```bash
pnpm --filter @poker/web dev     # http://localhost:3000
```

With no `NEXT_PUBLIC_SERVER_URL` set, every network call is answered from
`apps/web/fixtures/`: sign-in takes any number and the code `424242`, and
`/table/FELT42` replays a recorded hand — six seated, a short stack all in on
the flop, a main pot and a side pot paid to different players. A replay bar
gives play, pause, step, restart and speed, and holds at each of the viewer's
turns so the action bar, the raise slider and the timer ring are all really
exercised.

The recording is _data_, not a simulation — a client that could work out a side
pot would be a client with poker rules in it. `test/scripted-hand.test.ts`
replays its patches over its own whole states and fails if the two ever
disagree, which is what keeps a hand-written fixture honest.

Set `NEXT_PUBLIC_FIXTURE=0` to force the real server, or append `?fixture=1` /
`?live=1` to any URL to override per page load.

## Playing a hand

Sitting down and joining the game are two separate acts. Taking a chair puts
chips on the table; a seat is dealt out until its player says "I'm in", which is
what stops somebody posting a blind they never meant to and lets four friends
arrive one at a time and still be in the same first hand.

After that the table runs itself. Readiness is sticky, so hands deal one after
another until a player sits out, stands up or the host pauses. Between them:

- **Sitting out** takes effect from the _next_ hand. The one in progress is
  unaffected — you have chips in that pot and a hand to play.
- **Standing up** mid-hand does not fold on the spot. The seat is marked and
  folds when the action reaches it, because folding out of turn tells everybody
  still to act something they have not paid to know, and takes a free check away
  from a player who had one. The chips already committed stay in the pot and the
  seat empties when the hand ends.
- **Rebuying** is between hands only, and only up to the table maximum. A rebuy
  that would take a stack past it is refused rather than trimmed.
- **Pausing** is the host's, and never interrupts a hand: the one in progress
  plays out to its payout, and no more are dealt until they resume.

### The showdown

Cards go face up one phase before the chips move — `showdown`, then a two-second
beat, then `payout`. The beat is the _server's_: everyone at the table gets the
same pause, and a client that renders instantly still cannot show the pot moving
before the hands are shown.

Who shows is the table's order, not the seat numbering's. The last player to bet
or raise on the final street turns over first; if nobody bet, the first live seat
left of the button does; everyone else follows clockwise. Then, in that order, a
hand is shown only if it can still win something, and mucked if it cannot. **A
mucked hand's cards never leave the server** — they are not in a `HAND_REVEALED`,
not in `hand:result`, and not in any `state:sync` — unless its owner presses
Show, which is the only thing that adds a seat to the face-up set after the fact.

### When the connection drops

The client says which of three states it is in — connected, reconnecting,
disconnected — and the action bar is dead in the last two. Nothing is ever
buffered into a socket that is not there: a fold that arrived whenever the link
came back would land in a hand that had long since finished.

Reconnection backs off from half a second to ten, doubling, with jitter. On the
way back the client re-joins the table (a new socket is at no table until it says
so) and then asks for a whole `state:sync` rather than trying to bridge the gap
with patches it never received. A version that skips forward does the same thing.
The seat and its chips are held throughout, and the action clock keeps running —
a disconnected player still folds or checks when their time is up rather than
holding the table.

## The record of play

Five tables hold it: `tables`, `table_sessions`, `hands`, `hand_players` and
`hand_actions`. A hand is written as it happens — the row appears when it is
dealt and the actions stream in behind it — so the record is live rather than a
summary posted afterwards.

### Cards at rest

`hand_players.hole_cards` is **null from the moment the row is written until the
hand is over**, and it is filled in the same transaction that sets
`hands.ended_at`. A dump taken mid-hand — a backup, a replica, a curious
`select *` — contains nobody's cards, because they have not been written yet.
Not filtered on the way out: absent.

`hands.deck_seed` follows the same rule, for the same reason. The seed _is_ the
deck; publishing it early would publish every card in the hand.

`test/history-cards-at-rest.test.ts` plays real hands into a real sink and
inspects it the way `pg_dump` would, at every step of the hand. It also asserts
the negative directly: nothing card-shaped reaches the sink at all until the
hand ends.

Every dealt hand is recorded, including the ones that mucked — an audit trail
that skipped them could not prove the deal was straight, since the seat nobody
saw is where a crooked deal would hide. What mucking controls is who may _read_
them back: your own always, somebody else's only if they showed.

### Writes never block a hand

`HistoryRecorder.record()` puts a value on a queue and returns. It is
synchronous, it cannot throw, and there is no failure a caller could handle —
because the caller is a table with four people waiting on it.

When the database is unwell, writes retry with a backoff and the queue holds its
order (a hand cannot be written before the table it was dealt at, so a failure
blocks the queue rather than being skipped past). The table keeps dealing; the
history falls behind and **says so** — `statsPaused` on the API, a banner on the
history page. The queue is bounded, because trading a database outage for an
out-of-memory kill would take the tables with it.

### Provable fairness

Before a hand: 32 random bytes, `sha256` of them published to the table as
`deckCommit`, and the shuffle taken from the bytes themselves. After the hand:
the bytes are published, as `deck:revealed` and in the record.

`GET /hands/:id/verify` re-runs both halves, and both have to hold:

- the seed hashes to the commitment that went out **before** the deal, so the
  server cannot have picked a seed to suit the cards after seeing them
- the deck that seed produces, dealt out again, is the deal that actually
  happened, so the server cannot have committed to one deck and dealt another

Either check alone proves nothing, so the UI reports them separately. The deal is
replayed with `planDeal` and `createSeedRng` from `packages/engine` — the same
functions the table dealt with, shared precisely so the auditor and the dealer
cannot drift apart.

`createSeedRng` uses all 256 bits of the seed. A generator that folded them to 32
would let anyone brute-force the deck between the commitment and the reveal, and
that is the whole thing the commitment exists to prevent. It is pinned by
`packages/engine/test/seed-rng.test.ts`, which holds the decks two fixed seeds
produce: changing the RNG makes every stored hand unverifiable, so those literals
failing means revert, not update.

### Reading it back

| Endpoint                  | What it gives                                     |
| ------------------------- | ------------------------------------------------- |
| `GET /tables/:code/hands` | The last 50 finished hands, with pot and winners. |
| `GET /hands/:id`          | One hand: its players and every recorded action.  |
| `GET /hands/:id/verify`   | The fairness check, recomputed.                   |

All three need an access token, and all three redact on the way out.

The web client puts this at **`/table/[code]/history`**: fifty hands, each
expanding into a step-by-step replay driven by `hand_actions` — step forwards and
back through the hand, with the board and pot as they stood at each point — and a
link to the fairness verification for that hand.

## Leaderboards

Two of them, and they have almost nothing in common beyond the name.

### Live — this table, this sitting

Derived from the `TableRuntime`'s own memory and **never stored**: seat, name,
current stack, net for this sitting, hands won, biggest pot won. It is rebuilt
every time the table publishes anything — which is every time a stack moves —
and it rides along on `state:patch` rather than waiting for the next whole
state, because a board that only refreshed on a resync would spend most of a
hand showing the stacks from the last street.

It is built by `liveLeaderboard()` in `table/redact.ts`, beside `redactFor()`,
because a board is table state and table state leaves through one file
(CLAUDE.md §1). `net` is stack minus buy-in and every rebuy, so chips bought in
from outside the game never look like a win.

The client draws it as a collapsible panel beside the felt, biggest stack first,
with the viewer's own row pinned to the top when it would otherwise have
scrolled out of sight — and not pinned when it is already visible, because
showing the same person twice is worse than not pinning at all.

### Global — every hand, ever

On hand end, in one transaction:

```
player_stats(user_id pk, hands_played, hands_won, showdowns_seen, showdowns_won,
             net_chips bigint, biggest_pot, best_hand_category, best_hand_at,
             total_wagered, longest_win_streak, current_win_streak,
             big_blind_sum, updated_at)
player_stat_periods(user_id, period_key, …the same counters…)
```

**Postgres is the source of truth.** Redis holds a mirror in sorted sets, for
one reason: a top fifty and "what is my rank" in one round trip.

```
lb:net:alltime      lb:net:2026-09      lb:net:2026-W36   (60-day TTL)
lb:hands:…  lb:pot:…  lb:besthand:…  lb:winrate:…  lb:bb100:…
```

`ZINCRBY` on write for the running totals, `ZADD GT` for the maxima (a biggest
pot is a record, not a sum), and a plain `ZADD` for the two rates, recomputed
from the totals the transaction just returned. Reads are `ZREVRANGE key 0 49
WITHSCORES` for the board and `ZREVRANK` for your rank.

`rebuildLeaderboards()` regenerates **every** sorted set from `player_stats`,
on boot and hourly. Each board is built into a staging key and `RENAME`d over
the live one, so a reader sees the old board or the new one and never a
half-filled one. That job is why a Redis eviction policy is a capacity decision
rather than a data-loss one — and why the write path is allowed to be
best-effort: a missed mirror is a stale board for at most an hour.

Nothing computes a leaderboard by scanning `hand_actions`. That table is a
replay log with a row per action; the counters above exist precisely so no
request ever has to aggregate it.

### The threshold

```
BB/100 = net_chips / big_blind / hands_played * 100
```

where `big_blind` is `big_blind_sum / hands_played` — the blind those hands were
actually played for. For a player who has only ever sat at one table that is
that table's big blind, and the formula is unchanged; for one who has moved
between stakes it is their hand-weighted average, which is the only divisor that
means anything.

**A rate metric ranks nobody with fewer than 200 hands behind them.** A ratio
over three hands is noise wearing a number's clothes, and one lucky session would
otherwise sit on top of BB/100 for ever. It is enforced as _membership_ — an
unqualified player is not in the sorted set at all — so they cannot appear in a
top fifty and have no rank, however the board is read. They are not hidden,
though: their own row says "137 more hands to qualify" where the position would
be, and they rank normally on the totals, which are sums rather than ratios.

`best_hand_category` counts only hands that were actually turned face up at a
showdown. A mucked hand is its owner's (CLAUDE.md §1) — mucking is a refusal to
publish, not a delay on it — and a public statistic quietly built out of cards
nobody was shown would be publishing them the long way round.

### Reading the boards

| Endpoint                         | What it gives                                           |
| -------------------------------- | ------------------------------------------------------- |
| `GET /leaderboard?metric&period` | Top 50, plus the viewer's own row and rank. Cached 30s. |
| `GET /players/:id`               | One player's stat card, ranks, and last 20 hands.       |

Both need an access token; neither needs membership of anything. The web client
puts them at **`/leaderboard`** — tabs for all time / this month / this week, a
metric selector, and the viewer's row pinned at the top — and **`/player/[id]`**.
A player's recent hands say what each was worth and whether it reached a
showdown; what they were _holding_ is still `GET /hands/:id`, which redacts per
reader.

Without Postgres and Redis the whole thing runs in Maps, exactly as the record of
play does, so `pnpm dev` on a laptop with nothing installed still has working
leaderboards.

## End-to-end

`apps/e2e` starts the game server and the web app for real, on their own ports,
and drives four Chromium contexts through the actual interface: type a phone
number, read the code out of the server's console, pick a name, take a seat,
press Fold.

```bash
pnpm --filter @poker/e2e browsers    # once
pnpm --filter @poker/e2e test:e2e
```

Two specs:

- **one complete hand** — four players sit, blinds post, a preflop raise with two
  calls and a fold, a flop of check-check-bet-call-call, turn, river, showdown.
  Then the chips: everybody is down by exactly what they put in, one of them is
  up by exactly the pot, the folder is down its big blind and no more, and the
  four stacks still add to four thousand.
- **twenty consecutive hands** — nobody scripts this one. A loop finds whoever is
  on the clock, presses the free option, and repeats. After every hand all four
  browsers are asked for all four stacks and every answer has to match every
  other one; busted players rebuy; and at the end nothing may have been decided
  by an action clock running out.
- **hand history** — three players play a couple of hands, then open the history
  and step through a replay of one, and verify its deal.

Three things differ from a deployment, and `assertNotProduction` refuses all
three when `NODE_ENV=production`: `AUTH_STORE=memory`, `TABLE_RNG_SEED` (so the
deck is the same on every run), and short table timings.

## Production build

```bash
pnpm build
pnpm --filter @poker/server start   # node dist/index.js
pnpm --filter @poker/web start      # next start
```

## Project rules

Read [`CLAUDE.md`](./CLAUDE.md) before writing code here. The short version: the
server owns the deck and redacts through one function, all poker rules live in
`packages/engine` as pure functions, randomness is injected and never
`Math.random`, no client-supplied amount is trusted, this is play money and stays
play money, and tests ship in the same change as the code.
