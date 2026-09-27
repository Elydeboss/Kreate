# AGENTS.md

Operating guide for anyone (human or agent) working in this repo. Read this before
writing code. Full rationale in `ARCHITECTURE.md`.

---

## What this is

**Pulse** — a social prediction market surface for live group moments. A small group
(**Circle**) opens a **Live Session** during an event; anyone creates a fast binary
prediction and anyone buys YES/NO with USDC while the event is still happening. A
scoreboard closes it out.

Built on the **Panta API** (Solana, USDC markets). Solo, 16-day hackathon.

**The Panta integration is the product.** Not a wrapper. Every price, trade, position
and claim comes from the Panta API. Nothing is simulated, ever.

---

## Stack

Next.js 15 App Router · TypeScript · Tailwind · `@solana/wallet-adapter-react` ·
`@solana/web3.js` · TanStack Query · Postgres · Vercel · QuickNode Solana mainnet-beta

```bash
npm run dev
npm run build
npm run db:migrate     # apply db/migrations in order
```

## Env

```
PANTA_API_KEY=pk_test_…        # server only. NEVER NEXT_PUBLIC_
DATABASE_URL=postgres://…
SOLANA_RPC_URL=https://….solana-mainnet.quiknode.pro/<token>/
```

The QuickNode token is in the URL path — the URL *is* the credential. Neither value
ever leaves the server. All env reads go through `src/lib/server/env.ts`.

---

## Hard rules

Violating any of these is a bug, not a style choice.

1. **`PANTA_API_KEY` never reaches the client.** No `NEXT_PUBLIC_` prefix on any secret.
   No secret in a component, no secret in a `useQuery` key, no secret in a log.
2. **All Panta calls go through `lib/panta/client.ts`.** It injects the key, checks the
   token bucket, applies cache, honours the circuit breaker, retries with jitter, and
   logs `X-Request-Id`. No `fetch` to `live-api.panta.market` anywhere else. Ever.
3. **Trailing slash on every Panta route.** `…/markets/create/quote/`, not `…/quote`.
4. **Two transaction shapes stay separate.** `lib/tx/createTx.ts` handles the
   pre-assembled `VersionedTransaction` from market creation. `lib/tx/instructionTx.ts`
   compiles the raw `instructions[]` from buy and claim. Do not merge them. Do not
   hand-roll either one — copy from `panta-api-playground`.
5. **Broadcast client-side.** The signed transaction never reaches our server. The
   client POSTs only the `signature` back for `register` / `submit` / `trades`.
6. **Postgres is a cache for Panta's domain.** If `pulse_markets` disagrees with
   `GET /markets/{id}/`, Panta is right. Refresh the cache. Never treat a local row as
   truth; never present a local value as live Panta data (ToU §5).
7. **No SQL in components.** `lib/db/queries/` owns it.
8. **Every write route takes an `Idempotency-Key`.** See `server/idempotency.ts`.
9. **"Powered by Panta" is unconditional.** Render `PoweredByPanta`. Do not hide it on
   any screen, state, or breakpoint. Do not reword it. (ToU §6)
10. **`session_events` is append-only.** Insert, never update or delete. The scoreboard
    is derived from it.

---

## Panta rules that shape the product

| Rule | Consequence in code |
|---|---|
| `startTime` ≥ now + 3600s unless breaking | **Every Live Mode market** is `marketType: "breaking"` + `eventInProgress: true`. Not optional. |
| `imageUrl` required, catalog-only, 1024×1024 | Use a pre-seeded tile from `public/market-tiles/`. Never the upload flow on the demo path. |
| Event PDA = f(`question`, `wallet`) | `DUPLICATE_MARKET` on repeats. Session dedupe + session nonce in `question`. |
| Blockhash ~60s | Quote on sheet open, build on confirm, pre-warm, auto-requote once on `QUOTE_STALE`. |
| `createId` ~5 min · `quoteId` ~90s · `orderId` ~120s | Expiry handling per `ARCHITECTURE.md` §3.5. |
| Create = base units (`"50000000"`) · Buy = decimal (`"20.00"`) | Never mix these. |
| No resolution endpoint | Claims demoed against markets Panta's oracle resolved earlier. |
| Creator fees need a graduated market | Feature not built. Do not add it. |
| Rate limits per API key, shared by all users | Token buckets. `build` is 20/min and will be the first to break. |
| `markets/list` returns `null` prices | Every price comes from `markets/{id}`, cached. |
| Attribution is per key, not per user | Pass `userId` on quote + build. Per-user ownership lives in Postgres. |

---

## What exists today

Built and type-checking:

```
db/migrations/001_init.sql     full schema + v_scoreboard + v_session_markets
scripts/migrate.ts             forward-only migration runner
src/lib/server/env.ts          the only place process.env is read
src/lib/panta/types.ts         every Panta response shape + amount-format brands
src/lib/panta/errors.ts        Panta code -> user copy + retry policy
src/lib/panta/limiter.ts       token buckets, per family, fail-open
src/lib/panta/breaker.ts       circuit breaker
src/lib/panta/cache.ts         TTL + single-flight + stale-while-revalidate
src/lib/panta/client.ts        the only Panta caller; typed route helpers
src/lib/tx/createTx.ts         SHAPE A — pre-assembled VersionedTransaction
src/lib/tx/instructionTx.ts    SHAPE B — compile raw instructions
src/lib/tx/broadcast.ts        sign, broadcast, confirm, poll order status
src/lib/db/index.ts            pool, query, transaction
src/server/idempotency.ts      replay protection for write routes
src/app/api/ops/health/route.ts  the day-1 de-risk check
```

Not built: every screen, every component, `lib/db/queries/*`, and the
`PoweredByPanta` / `StalenessStamp` components the ToU obligations depend on.
Those are schedule days 4-12 in `ARCHITECTURE.md` §10.

Verify the integration layer before touching UI:

```bash
curl -s localhost:3000/api/ops/health | jq
```

---

## Where things live

| Task | File |
|---|---|
| Any Panta call | `src/lib/panta/client.ts` |
| Panta response types | `src/lib/panta/types.ts` |
| Error code → user copy | `src/lib/panta/errors.ts` |
| Cache + single-flight | `src/lib/panta/cache.ts` |
| Rate limiting | `src/lib/panta/limiter.ts` |
| Circuit breaker | `src/lib/panta/breaker.ts` |
| Create-market tx | `src/lib/tx/createTx.ts` |
| Buy/claim tx | `src/lib/tx/instructionTx.ts` |
| Broadcast + confirm | `src/lib/tx/broadcast.ts` |
| Idempotency | `src/server/idempotency.ts` |
| Attribution badge | `src/components/ui/PoweredByPanta.tsx` |
| Staleness stamp | `src/components/ui/StalenessStamp.tsx` |
| Live Session room | `src/app/s/[sessionId]/page.tsx` |

---

## Conventions

**Errors.** Switch on Panta's `code`, never on HTTP status. Every error renders a
human message (`errors.ts`) and a retry affordance. Never show a raw Panta `message`
string to a user — some are developer-facing. Always surface the Panta `X-Request-Id`
in logs.

**Loading.** Any Panta-backed surface needs explicit loading, empty, and error states.
A `null` price is not zero. "No positions yet" is not an error.

**Polling.** TanStack Query, 10–15s for session markets and the trade feed, 30s for
positions. Refetch on window focus off. Server caches, so client polling is cheap.

**Cache keys.** User-scoped dimension **first**: `['positions', wallet]`,
`['market', marketId]`. Never coalesce user-scoped reads on path alone.

**Idempotency.** Client generates a UUID per user intent, sends it as `Idempotency-Key`,
and reuses the *same* key on retry. New key on new intent.

**Attribution.** `userId` = your `pulse_markets`/`users` id, sent on primary quote and
build. Report every buy and every claim to `/trades/`. Never report a creator-fee claim.

---

## Anti-patterns

- A background 20s poller. Serverless won't hold it. Lazy cache instead.
- A `Map<string, Promise>` for single-flight that deletes in `.then()` instead of
  `.finally()`. A rejected promise then sticks and is served as a cached failure forever.
- Passing a per-caller `AbortController` into a shared coalesced request. The first
  unmount aborts it for everyone.
- A fixed-window limiter. Use token buckets; return `Retry-After` in seconds with jitter
  so clients don't stampede on window reset.
- A limiter that fails closed. It protects Panta; it must never be why Pulse is down.
- Persisting positions as truth. Read them live, cache 30s.
- Fetching `markets/{id}` once per position row. Once per **distinct** `marketId`.
- Synthesising a "who's on which side" view. It does not exist as an endpoint, and
  presenting invented data as Panta data violates ToU §5. Use `/markets/{id}/trades/`.
- Reaching for Mongo, Kafka, Redis, or a gateway. None are justified at this scale.
- A second deployment. One app.

---

## Before you call anything done

- [ ] Works on a real phone viewport, on cellular data.
- [ ] Loading, empty, and error states all exist and are readable.
- [ ] `QUOTE_STALE` / `QUOTE_EXPIRED` / `CREATE_EXPIRED` / `RATE_LIMITED` each recover
      without a page reload.
- [ ] Double-tapping a write does not create two markets.
- [ ] `PoweredByPanta` present on every screen that shows Panta data.
- [ ] `StalenessStamp` present wherever prices are cached.
- [ ] No secret in the client bundle. Check the built output.
- [ ] Every Panta write reported for attribution.
- [ ] The create-prediction path rehearsed end to end, five times, in under 30 seconds.

---

## Rehearsal is a deliverable

The create-prediction path is the demo. Rehearse it until it is boring:

1. Panta key present, `canCreateMarkets: true`.
2. Pre-seeded tiles reachable from your CDN over HTTPS.
3. `breaking` + `eventInProgress: true` on every session market.
4. Demo wallets funded, and one already holding YES on a pre-resolved market.
5. Fresh markets pre-created 24–48h ahead so the oracle has resolved them.
6. Rehearse the price-cache cold path, not just the warm one.

If any of these is untrue, the demo dies on stage and no amount of UI polish saves it.
