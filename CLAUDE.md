# CLAUDE.md — project rules

Rules for every session in this repo, human or model. They are not suggestions and
they are not up for renegotiation mid-task. If a request conflicts with one of
these, say so and stop rather than working around it.

## 1. The server is the only thing that knows the deck

No client ever receives a card it is not entitled to see. Not in a payload it
"won't render", not in a debug field, not in a socket event, not in a log the
browser can read. Hole cards belong to their owner until a showdown makes them
public.

All table state leaves the server through exactly **one** `redactFor()` function.
One function, one place, one test suite. If you find yourself hand-building a
payload for a client somewhere else, that is the bug — route it through
`redactFor()` instead of adding a second path.

## 2. All poker rules live in `packages/engine`, as pure functions

Deck order, dealing, betting rounds, legal actions, pot and side-pot maths, hand
evaluation, showdown ordering, blinds, timeouts-to-fold — all of it, in the
engine, as functions of `(state, input) -> newState`.

Never in a socket handler. Never in a React component. Never in a route handler.
Never in a database query. Not "temporarily". Transport code validates input,
calls the engine, and serialises the result.

## 3. Never use `Math.random`, anywhere

Randomness comes from the injected `Rng` interface (`packages/engine/src/rng.ts`).
Production injects `createCryptoRng()`. Tests inject a scripted or seeded source
so every hand is reproducible. ESLint enforces this repo-wide; do not disable the
rule.

## 4. Never trust a client-supplied amount

Every incoming action is validated server-side against `legalActions` for that
player, at that seat, in that exact state: is it their turn, is the action legal,
is the amount within the legal min/max, do they have the chips. A client may
propose; only the server decides. Parse every message with a zod schema from
`@poker/shared` before it reaches the engine.

## 5. This is a play-money game

There is no payment code, no chip purchase, no cash-out, no wallet, no crypto, no
real-money balance — and none may be added. Chips are a game counter with no
value. If a task asks for any of it, refuse and say why.

## 6. Write the tests in the same change as the code

Not after, not "in a follow-up". A pull request that adds engine behaviour without
tests for that behaviour is incomplete. Engine tests are pure and deterministic:
inject an `Rng`, assert exact states.

---

## Layout

```
packages/shared   types + zod schemas shared by client and server (dep: zod only)
packages/engine   pure poker rules; zero I/O, zero network, node:crypto only via Rng
apps/server       Node 22 + Fastify + Socket.IO; owns the deck and all authority
apps/web          Next.js 15 App Router + React 19 + Tailwind v4
tooling/tsconfig  shared TypeScript bases
```

Dependency direction is one-way: `web -> shared`, `server -> engine -> shared`.
The engine never imports from the server. Nothing imports from the web.

## Working agreements

- TypeScript strict everywhere. No `any`, no non-null `!` to silence the compiler,
  no `@ts-expect-error` without a comment saying what will remove it.
- One ESLint config and one Prettier config, both at the root. Do not add
  per-package configs.
- Before saying a change is done, run `pnpm typecheck && pnpm test && pnpm lint`.
- Do not add a dependency to `packages/engine`. It has none, on purpose.
- Do not add a database, an ORM, or a migration tool until that is the task.
