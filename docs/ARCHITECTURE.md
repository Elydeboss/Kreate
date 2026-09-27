# Pulse — Architecture

> Reference document. Every Panta call, every table, every folder, and the failure
> modes that will bite you. Read §3 and §7 before writing code.

---

## 1. System overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Next.js client components)                            │
│  wallet adapter · session UI · polling 10–15s                    │
│  ⚠ never holds the Panta key · signs + broadcasts txs            │
└───────────────┬─────────────────────────────────────────────────┘
                │  fetch('/api/...')   — your own origin only
┌───────────────▼─────────────────────────────────────────────────┐
│  BFF — Next.js route handlers (the backend)                     │
│                                                                  │
│  lib/panta/cache.ts     TTL + single-flight coalescing           │
│  lib/panta/limiter.ts   token buckets per Panta rate family      │
│  lib/panta/breaker.ts   circuit breaker + staleness stamp         │
│  lib/panta/client.ts    typed Panta client, injects key + bucket  │
│  lib/tx/                instruction → VersionedTransaction        │
│  server/idempotency.ts  replay protection on every write route   │
│                                                                  │
│  Postgres: your domain (authoritative) + Panta correlation       │
└───────────────┬──────────────────────────┬──────────────────────┘
                │ X-Api-Key (server only)  │ JSON-RPC
┌───────────────▼──────────────┐  ┌────────▼───────────────────────┐
│  live-api.panta.market/api/v1│  │  QuickNode Solana mainnet-beta │
│  (USDC markets, oracle)      │  │  (broadcast, confirmations)   │
└──────────────────────────────┘  └────────────────────────────────┘
```

**Why a BFF and not a split backend.** Sam Newman's BFF pattern: the user-facing app is
a client outside your perimeter plus a server-side component inside it, tightly coupled
to one user experience. Three things force this shape:

1. The Panta key cannot reach the browser (ToU §3, and Panta's own quickstart).
2. The rate-limit budget is **per API key, shared by every user**. It needs one place
   to be metered.
3. The price cache needs one process to coalesce concurrent misses.

A split frontend/backend adds CORS, two deploys, duplicated types and a contract to
maintain, for one developer, for zero benefit. The route handlers *are* the backend.

**Why no API gateway / Redis / event bus.** Microsoft: *"Evaluate whether you need
this pattern."* For one app with one upstream it is pure overhead. In-memory token
buckets are sufficient until there is more than one instance.

---

## 2. Stack

| Layer | Choice | Note |
|---|---|---|
| Framework | Next.js 15 App Router, TypeScript | Route handlers = BFF |
| Styling | Tailwind CSS | Mobile-first |
| Wallet | `@solana/wallet-adapter-react` | Phantom, Solflare |
| Solana client | `@solana/web3.js` | v1 for `VersionedTransaction` ergonomics |
| Data fetching | TanStack Query | Polling + cache invalidation |
| DB | Postgres (Neon or Supabase) | |
| Deploy | Vercel | Lazy cache, no background poller |
| RPC | QuickNode Solana mainnet-beta | Token lives in the URL path |

**No background poller.** Serverless functions do not hold a 20s loop reliably. Use
lazy TTL cache with in-flight coalescing (below). If you later need true background
polling, move the whole app to Fly.io or Railway.

---

## 3. Panta integration contract

Base URL `https://live-api.panta.market/api/v1`. **Trailing slashes are required on
every route.** Auth via `X-Api-Key: pk_…` (or `Authorization: Bearer`).

### 3.1 Endpoints used

| # | Endpoint | Used for |
|---|---|---|
| 1 | `POST /auth/register/` | One-time key minting setup |
| 2 | `POST /account/keys/` | Mint the `pk_` key |
| 3 | `GET /account/` | Verify `canCreateMarkets` |
| 4 | `GET /categories/` | Category chips on create form |
| 5 | `GET /markets/` | Pulse market directory, `createdBy=me` |
| 6 | `GET /markets/{id}/` | **Only live-price source.** `yesPrice`/`noPrice` |
| 7 | `GET /markets/{id}/trades/` | Live trade feed, YES/NO volume split |
| 8 | `GET /wallets/{addr}/trades/` | Wallet trade history |
| 9 | `POST /markets/create/image-upload/` | Custom image path (off demo path) |
| 10 | `POST /markets/create/quote/` | Create quote → `createId` |
| 11 | `POST /markets/create/build/` | Unsigned `VersionedTransaction` |
| 12 | `POST /markets/register/` | Register after broadcast |
| 13 | `POST /primaryorderquote/` | Buy quote → `quoteId` |
| 14 | `POST /primaryorderbuild/` | `instructions[]` → `orderId` |
| 15 | `POST /primaryordersubmit/` | Register signature (idempotent) |
| 16 | `POST /primaryorderverify/` | Poll `built→submitted→confirmed\|failed` |
| 17 | `GET /positions/` | My Positions |
| 18 | `POST /claim/build/` | Win claim instructions |
| 19 | `POST /trades/` | Attribution on every buy + claim |
| 20 | `GET /account/metrics/` | Pulse stats page |
| 21 | `GET /account/creates/` | Market directory / reconciliation |
| 22 | `GET /account/trades/` | Attributed volume |

`GET /markets/` **does not** live-RPC prices — `yesPrice` is `null` on list rows.
`GET /markets/{id}/` does. Every price in the UI comes from the detail route.

### 3.2 The two transaction shapes

This is the single most important thing in the integration. They are not the same.

**A. Create market** — `build` returns a pre-assembled unsigned transaction.

```ts
const tx = VersionedTransaction.deserialize(
  Buffer.from(res.transaction, 'base64')
);
tx.sign([walletAdapter]);                    // wallet adapter has publicKey + signTransaction
const sig = await connection.sendRawTransaction(tx.serialize(), {
  maxRetries: 3,
  skipPreflight: false,
});
await panta.post('/markets/register/', { createId, signature: sig });
```

**B. Primary buy / win claim** — `build` returns raw instructions. You compile.

```ts
const message = new TransactionMessage({
  recentBlockhash: res.recentBlockhash,
  payerKey: wallet.publicKey,
  instructions: res.instructions.map(toTransactionInstruction),
}).compileToV0Message();

const tx = new VersionedTransaction(message);
tx.sign([walletAdapter]);
const sig = await connection.sendRawTransaction(tx.serialize());

function toTransactionInstruction(ix: PantaInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}
```

**Broadcast client-side.** The signed transaction never reaches your server. The client
POSTs only the resulting `signature` to your BFF for `register` / `submit` / `trades`.
This keeps signing and broadcasting in one place and sidesteps RPC CORS entirely.

### 3.3 Amount formats — easy mistake

| Surface | Format | Example |
|---|---|---|
| Create market | USDC **base units**, integer string (6 dp) | `"50000000"` = 50 USDC |
| Primary buy | Human-readable decimal string | `"20.00"` |

### 3.4 Create-market parameters for Live Mode

Every Live Mode market is a **breaking** market with `eventInProgress: true`. This is
mandatory, not optional:

> `startTime` must be at least on-chain `minimumStartDelay` ahead of now (typically
> 3600s) **unless `eventInProgress` is true on a breaking market**.

| Field | Value |
|---|---|
| `marketType` | `"breaking"` |
| `eventInProgress` | `true` |
| `startTime` | now (or now − small delta) |
| `endTime` | session end; **must be in the future** |
| `resolutionTime` | `endTime` + small buffer |
| `imageUrl` | pre-seeded 1024×1024 tile from your CDN — **required** |
| `category` | `sports` (from `/categories/`) |
| `sourcesOfTruth` | the stream URL, or the competition/monitor |
| `userId` | your `pulse_user_id` — for attribution |

`standard` markets keep the 3600s delay. Use them only for long-horizon markets, never
inside a live session.

### 3.5 Expiry and error matrix

| Code / condition | Meaning | Handling |
|---|---|---|
| `CREATE_EXPIRED` | `createId` gone (>~5 min) | Re-quote automatically, once |
| `QUOTE_EXPIRED` | `quoteId`/`orderId` gone | Re-quote automatically, once |
| `QUOTE_STALE` | Curve moved past `maxSlippageBps` | Re-quote, surface new price to user |
| `AMOUNT_TOO_SMALL` | Below minimum fill | Show min, block submit |
| `MARKET_NOT_IN_PRIMARY` | Not accepting primary buys | Disable Buy, show state |
| `DUPLICATE_MARKET` | Creator + question already exists | See §4.3 |
| `NOT_CLAIMABLE` | Win-claim preconditions failed | Hide claim, explain |
| `MARKET_NOT_GRADUATED` / `NO_CREATOR_FEES` | Creator fees unreachable | Feature not shipped |
| `RATE_LIMITED` (429) | Bucket exhausted | Honour `Retry-After` + jitter |
| Blockhash expired (~60s) | Build is stale | Rebuild from same `createId`/`orderId` if still in TTL, else re-quote |

**Blockhash is the demo killer.** The whole quote → build → sign → broadcast path must
finish inside 60s. On mobile with a wallet popup that is tight. Mitigation: call
`quote` when the user opens the buy sheet, call `build` only on confirm, and pre-warm
the blockhash. Rehearse this path five times.

### 3.6 Idempotency

Panta gives free retries on three routes:

| Call | Idempotent on |
|---|---|
| `POST /markets/register/` | same `createId` + `signature` |
| `POST /trades/` | same `signature` |
| `POST /primaryordersubmit/` | same `orderId` + `signature` |

Retry those freely. Your own BFF write routes additionally take a client-generated
`Idempotency-Key` (§7.4) so a double-tap on a flaky mobile connection cannot create two
markets.

### 3.7 Attribution

Pass `userId: <pulse_user_id>` on primary quote **and** build, or the `X-User-Id`
header. Then `GET /account/metrics/` and `GET /account/trades/` return volume credited
per Pulse user. The stats page renders this — it is the receipts for deep integration.

Never report a creator-fee claim to `/trades/`; it returns `TX_MISMATCH` by design.

---

## 4. Data model

### 4.1 The governing rule

**Separate your domain from Panta's domain, and never let them blur.**

| Domain | Authority | Storage |
|---|---|---|
| Circles, sessions, members, scoreboard | **You** | Postgres, authoritative |
| Markets, prices, positions, resolution | **Panta / chain** | Postgres, **cache only** |

A `pulse_markets` row is a *pointer plus a denormalised snapshot*. If it disagrees with
`GET /markets/{id}/`, Panta wins and the cache refreshes. Never treat a local row as
source of truth, and never present a local value as live Panta data (ToU §5).

### 4.2 Schema

```sql
-- ── Your domain: authoritative ────────────────────────────────────────────

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet        TEXT UNIQUE NOT NULL,          -- base58, the identity
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE circles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT UNIQUE NOT NULL,            -- short invite code, e.g. 'AB3XQ'
  name        TEXT NOT NULL,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE circle_members (
  circle_id  UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);

CREATE TABLE live_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id   UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  stream_url  TEXT,                            -- optional; Pulse never embeds video
  status      TEXT NOT NULL DEFAULT 'active',  -- active | ended
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at     TIMESTAMPTZ NOT NULL,            -- drives market endTime
  ended_at    TIMESTAMPTZ
);

-- Append-only ledger. The scoreboard and activity feed read from this.
-- (This is the shape evtstore would give you, without the library or MongoDB.)
CREATE TABLE session_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,   -- session.started | market.created | trade.reported
                              -- | claim.reported | market.resolved | session.ended
  actor_user_id UUID REFERENCES users(id),
  market_id     UUID,            -- -> pulse_markets.id
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON session_events (session_id, id DESC);

-- ── Panta correlation: cache + pointer, never authoritative ──────────────

CREATE TABLE pulse_markets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panta_market_id    TEXT UNIQUE,               -- event PDA; NULL until registered
  circle_id          UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  session_id         UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  created_by         UUID NOT NULL REFERENCES users(id),

  -- uniqueness key. question carries a session nonce so repeated demos
  -- don't collide on DUPLICATE_MARKET. title is what users see.
  question           TEXT NOT NULL,
  title              TEXT NOT NULL,
  resolution_rule    TEXT NOT NULL,
  sources_of_truth   TEXT[] NOT NULL,
  category           TEXT NOT NULL,
  image_url          TEXT NOT NULL,
  market_type        TEXT NOT NULL DEFAULT 'breaking',

  -- snapshot, refreshed from GET /markets/{id}/
  phase              TEXT,                      -- primary|secondary|resolved|cancelled
  resolved           BOOLEAN NOT NULL DEFAULT false,
  outcome            TEXT,                      -- 'yes' | 'no' | NULL
  yes_price          NUMERIC(6,4),
  no_price           NUMERIC(6,4),
  volume_usdc        NUMERIC(18,6),
  prices_as_of       TIMESTAMPTZ,               -- drives the staleness stamp
  snapshot_at        TIMESTAMPTZ,

  start_time         BIGINT NOT NULL,
  end_time           BIGINT NOT NULL,
  resolution_time    BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON pulse_markets (session_id);
CREATE INDEX ON pulse_markets (circle_id, created_at DESC);

-- Real on-chain flow, read from GET /markets/{id}/trades/. Never synthesised.
CREATE TABLE market_trades (
  signature      TEXT PRIMARY KEY,
  panta_market_id TEXT NOT NULL,
  wallet         TEXT NOT NULL,
  side           TEXT,                          -- derived from yesAmount/noAmount
  shares         NUMERIC(24,6) NOT NULL,
  fee_paid       NUMERIC(18,6),
  block_time     BIGINT,
  quote_asset    TEXT,
  session_id     UUID REFERENCES live_sessions(id) ON DELETE SET NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON market_trades (panta_market_id, block_time DESC);
CREATE INDEX ON market_trades (session_id, block_time DESC);

-- ── Correlation + replay protection ──────────────────────────────────────

CREATE TABLE panta_creates (
  create_id        TEXT PRIMARY KEY,
  pulse_market_id  UUID NOT NULL REFERENCES pulse_markets(id) ON DELETE CASCADE,
  wallet           TEXT NOT NULL,
  payment_usdc     TEXT,
  expected_event_pda TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  signature        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE panta_orders (
  order_id      TEXT PRIMARY KEY,
  quote_id      TEXT,
  pulse_market_id UUID NOT NULL REFERENCES pulse_markets(id) ON DELETE CASCADE,
  wallet        TEXT NOT NULL,
  side          TEXT NOT NULL,
  amount_usdc   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'built', -- built|submitted|confirmed|failed|expired
  signature     TEXT,
  user_id       TEXT,                          -- Panta attribution id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON panta_orders (wallet, created_at DESC);

CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  route        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INT NOT NULL,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.3 The `DUPLICATE_MARKET` design decision

Panta derives the event address from `question` + `wallet`, and rejects a repeat with
`DUPLICATE_MARKET`. Collaborative creation would therefore collide — which is exactly
what Live Mode is.

Two fixes, both deliberate and both worth explaining in the README:

1. **App-level dedupe (product feature).** Before quoting, check for an open Pulse
   market in this session with the same normalised question. If one exists, offer
   *"join the existing prediction"* instead of creating a duplicate. Turns an API
   constraint into better UX. This is the reason two different wallets *can* create the
   same question at all — the PDA is per-wallet.
2. **Session nonce in `question` (demo re-runnability).** `question` carries a suffix
   like `[AB3XQ#12]`; `title` stays clean because display reads `title` and uniqueness
   reads `question`. This mints a *new* market — and a new creation fee — so treat it as
   a scalpel, not a default. Reuse markets across demo runs when you can.

### 4.4 Positions are not stored

`GET /positions/` is wallet-scoped and **share**-denominated, capped at ~200 rows, and
can lag the chain briefly. Two rows for the same market (one per side) is expected, not
a duplicate bug.

- Never persist positions as truth. Read them live, cache ~30s.
- USD value is computed client-side: `shares × yesPrice|noPrice` while open; after
  resolution, `shares × 1` if `side === outcome`, else `0`.
- Fetch `GET /markets/{id}/` once per **distinct** `marketId`, not once per row.
- If a user has several wallets, positions are per wallet. Circle-wide position views
  mean N `positions` calls, against a 60/min cap. Do not build that view.

### 4.5 Event sourcing: the verdict

Rejected, deliberately. Rationale in §"evtstore" of the project README:

- Panta is the system of record for market/position state. Event-sourcing a mirror of
  someone else's ledger buys drift, not truth.
- The audit trail already exists and is authoritative: `/markets/{id}/trades/` and
  `/account/trades/`.
- Live UI + projection lag is the wrong trade for a watch party.
- It adds MongoDB alongside Postgres.

What we *do* take is the shape: `session_events` is append-only, and the scoreboard is
a derived read model over it. That is event-sourcing's actual benefit — an auditable
history — at Postgres cost.

**Revisit only if** Pulse ever becomes the system of record for something it owns
end-to-end, or if you need full temporal replay for analytics.

---

## 5. Folder structure

```
pulse/
├─ docs/
│  ├─ PRD.md
│  ├─ ARCHITECTURE.md              ← you are here
│  ├─ architecture-essentials.md   ← the one-page decision summary
│  └─ AGENTS.md
├─ public/
│  └─ market-tiles/                ← pre-seeded 1024×1024 PNGs, one per template
├─ db/
│  └─ migrations/                  ← raw SQL, applied in order
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx                  ← landing: connect wallet, create/join circle
│  │  ├─ c/[code]/page.tsx         ← Circle: members, sessions, market list
│  │  ├─ s/[sessionId]/page.tsx    ← ★ Live Session room
│  │  ├─ me/page.tsx               ← My Positions
│  │  ├─ stats/page.tsx            ← Pulse on Panta (attribution receipts)
│  │  └─ api/
│  │     ├─ panta/
│  │     │  ├─ markets/route.ts          GET  cached list
│  │     │  ├─ markets/[id]/route.ts      GET  cached detail + prices
│  │     │  ├─ markets/[id]/trades/route.ts GET cached tape
│  │     │  ├─ positions/route.ts        GET  cached, wallet-scoped
│  │     │  ├─ categories/route.ts       GET  cached
│  │     │  └─ metrics/route.ts          GET  stats page
│  │     ├─ create/
│  │     │  ├─ quote/route.ts            POST → createId + paymentUsdc
│  │     │  ├─ build/route.ts            POST → unsigned tx
│  │     │  └─ register/route.ts         POST → marketId   [idempotent]
│  │     ├─ order/
│  │     │  ├─ quote/route.ts            POST → quoteId, shares, avgPrice, fee
│  │     │  ├─ build/route.ts            POST → instructions, orderId
│  │     │  ├─ submit/route.ts           POST → submitted   [idempotent]
│  │     │  └─ verify/route.ts           POST → status
│  │     ├─ claim/route.ts               POST → instructions
│  │     ├─ report/route.ts              POST → /trades/ attribution
│  │     └─ pulse/
│  │        ├─ circles/route.ts          POST create, POST join by code
│  │        ├─ sessions/route.ts         POST start, POST end
│  │        ├─ events/route.ts           POST append to session_events
│  │        └─ scoreboard/[sessionId]/route.ts GET derived read model
│  ├─ components/
│  │  ├─ session/
│  │  │  ├─ MarketCard.tsx          price, buy, trade count
│  │  │  ├─ BuySheet.tsx            quote → build → sign → submit
│  │  │  ├─ CreatePrediction.tsx    template chips, live fee
│  │  │  ├─ TradeFeed.tsx           Panta tape, wallet → member
│  │  │  ├─ Scoreboard.tsx          derived from session_events
│  │  │  └─ SessionHeader.tsx       live status, countdown
│  │  ├─ circle/
│  │  │  ├─ CreateCircle.tsx
│  │  │  ├─ InviteLink.tsx
│  │  │  └─ MemberList.tsx
│  │  └─ ui/
│  │     ├─ PoweredByPanta.tsx      §6 attribution, ToU §6
│  │     ├─ StalenessStamp.tsx      ToU §5 — not optional
│  │     ├─ ErrorState.tsx          maps Panta codes → copy
│  │     └─ ...
│  ├─ lib/
│  │  ├─ panta/
│  │  │  ├─ client.ts               base URL, key injection, bucket check, retry
│  │  │  ├─ types.ts                every Panta response shape
│  │  │  ├─ errors.ts               code → user-facing message + retryability
│  │  │  ├─ cache.ts                TTL + single-flight
│  │  │  ├─ limiter.ts              token buckets per family
│  │  │  └─ breaker.ts              circuit breaker
│  │  ├─ tx/
│  │  │  ├─ createTx.ts             shape A — deserialize VersionedTransaction
│  │  │  ├─ instructionTx.ts        shape B — compile instructions
│  │  │  └─ broadcast.ts            sendRawTransaction + confirm
│  │  ├─ db/
│  │  │  ├─ index.ts
│  │  │  └─ queries/                one module per table, no SQL in components
│  │  └─ suggest.ts                 ~3h AI template suggester (should-have)
│  └─ server/
│     ├─ idempotency.ts             §7.4
│     └─ env.ts                     single place env vars are read and validated
└─ .env.local                      PANTA_API_KEY, DATABASE_URL, SOLANA_RPC_URL
                                   ⚠ never NEXT_PUBLIC_ anything from this list
```

**Rules the tree encodes:**

- `lib/panta/` is the **only** place that knows the Panta base URL or key. If a
  component imports `PANTA_API_KEY`, something is wrong.
- Nothing under `app/api/` calls Panta directly — routes go through `lib/panta/client.ts`
  so every call is metered, cached, broken and logged.
- No SQL in components. `lib/db/queries/` owns it.
- `lib/tx/` is the only place that touches transaction construction, because the two
  shapes must not get mixed.

---

## 6. Attribution component

Panta ToU §6 is prescriptive:

- exact wording **"Powered by Panta"** — no variants
- clear, legible, reasonably prominent
- in a location reasonably associated with the Panta-powered functionality
- may not be removed, hidden, obscured, minimised, or designed around
- links to `panta.market` where hyperlinks are supported

`PoweredByPanta.tsx` is used in: the market module, the trading interface, the
positions screen, the session header, and the footer. Render it from the component and
never conditionally.

Note: Panta sends `X-Powered-By: Panta` on API responses, but that header is only
visible to **server-side** clients. A browser SPA cannot read it. So the badge is a
hardcoded component, not header-driven.

---

## 7. Resilience layer

### 7.1 Rate limit budgets

Per Panta API key. Shared by every Pulse user. Defaults:

| Family | Cap / 60s | Pulse TTL | Notes |
|---|---|---|---|
| `read` | 120 | 20s | `markets/{id}` is the live-price call |
| `positions` | 60 | 30s | wallet-scoped |
| `quote` | 30 | n/a | short-lived session |
| `build` | **20** | n/a | **tightest constraint** |
| `register` | 40 | n/a | idempotent, free to retry |
| `upload` | 10 | n/a | off the demo path |

`lib/panta/limiter.ts` implements in-process token buckets: refill = cap/60 per second,
burst = cap. Three rules:

1. **Fail open.** The limiter protects Panta; it must never become the reason Pulse is
   down. Log and alert, then allow.
2. **`Retry-After` is delay-seconds with jitter.** Returning an absolute timestamp makes
   every client retry at the same instant and manufactures a thundering herd on window
   reset.
3. **Tier order: per-endpoint < per-account.** A lenient route must not let one caller
   burn the account's whole `build` budget.

### 7.2 Cache + single-flight

`markets/{id}` is one request per market against a 120/min shared budget. A 6-market
room refreshing every 5s is 72 req/min for a single user. So:

- **Clients poll your own origin at 10–15s.** Free.
- **Server serves from a TTL cache (20s).** On miss, one upstream call.
- **Single-flight coalescing.** A `Map<string, Promise>` — concurrent callers `await`
  the same in-flight promise. No dependency.

Two traps, both real incidents in the wild:

```ts
const inflight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = run().finally(() => {
    inflight.delete(key);   // ← finally, NOT then. A rejected promise left in the
  });                       //   map becomes a cached failure served forever.
  inflight.set(key, promise as Promise<unknown>);
  return promise;
}
```

- **Delete in `finally`, not `then`.** Otherwise a settled-rejected promise is handed to
  every future caller for that key.
- **Never pass one caller's `AbortController` into the shared request.** The first
  component to unmount aborts the fetch for everyone still waiting.
- **Key granularity is a security boundary.** Put the user-scoped dimension *first*:
  `positions:{wallet}:{id}` and `market:{id}`. Coalescing `positions` on path alone
  would serve one user's positions to another.

**Stale-while-revalidate (RFC 5861) on top.** On expiry, serve the cached price and
refresh in the background. Prices are genuinely safe a few seconds stale at a 20s TTL.
With a hard staleness ceiling and an alarm on refresh failure — otherwise a failing
origin is masked by quietly serving old data.

### 7.3 Circuit breaker

Panta ToU §14: no SLA, "as available," endpoints may be changed or discontinued. So
Panta will be slow or down. Trip after N consecutive failures; while open, serve stale
cache and surface the staleness stamp. **The stamp is a ToU §5 requirement, not polish** —
if the cache is serving data, the UI says how old it is.

### 7.4 Idempotency on BFF writes

Client generates a key (UUID) per user intent. `server/idempotency.ts` stores
`(key, route, request_hash) → response`. Same key + same hash → replay stored response.
Same key + different hash → `409`. Insert the key row *before* the side effect inside a
transaction, so a crash mid-write cannot double-create.

### 7.5 Retries

Exponential backoff **with random jitter**. Retry freely on `register`, `submit`,
`/trades/` (Panta is idempotent on those). Do not blindly retry `build` — handle
`CREATE_EXPIRED` / `QUOTE_EXPIRED` explicitly instead. Cap total retries as a fraction of
successful requests; unbounded retries amplify load during an incident.

---

## 8. Key flows

### 8.1 Create a prediction (the demo centrepiece)

```
tap chip "Goal before half-time"
  → POST /api/create/quote
       dedupe check in Postgres (same session + normalised question?)
         └─ exists → return existing marketId, UI offers "join existing"
       lib/panta client → POST /markets/create/quote/
         breaking + eventInProgress: true, imageUrl = tile, userId
       ← createId, paymentUsdc, expectedEventPda
       insert panta_creates (pending), pulse_markets (panta_market_id NULL)
       append session_events 'market.created'
  → show fee, "Confirm" enabled

tap Confirm
  → POST /api/create/build
       → POST /markets/create/build/  → base64 unsigned VersionedTransaction
  → wallet.signTransaction(tx)
  → connection.sendRawTransaction      ← client-side broadcast
  → POST /api/create/register  { createId, signature }
       → POST /markets/register/      → marketId, status registered
       → UPDATE pulse_markets SET panta_market_id
       → UPDATE panta_creates SET status='registered', signature
       → append session_events 'market.registered'
```

### 8.2 Buy

```
open BuySheet
  → POST /api/order/quote { wallet, marketId, side, amountUsdc, userId }
       → POST /primaryorderquote/  → quoteId, shares, avgPrice, feeUsdc
       → cache position quote under user's session (short TTL, ≤90s)
  → show "38.4 shares at 0.52 · fee 0.40 USDC"

tap Confirm                       ← must complete within ~60s blockhash
  → POST /api/order/build  → POST /primaryorderbuild/  → instructions, orderId
  → compile VersionedTransaction, wallet.signTransaction
  → sendRawTransaction
  → POST /api/order/submit { orderId, signature }  [idempotent]
  → POST /api/report   { signature, wallet, marketId, kind: 'buy' }   ← attribution
  → poll POST /api/order/verify until confirmed | failed
  → invalidate market price cache; next trade-feed poll picks it up
```

### 8.3 Claim

```
GET /positions?wallet → row with claimable: true
  → POST /api/claim { wallet, marketId }
      → POST /claim/build/ → instructions, outcome, winningShares
  → compile, sign, broadcast
  → POST /api/report { signature, ..., kind: 'claim' }
  → refresh positions
```

### 8.4 Scoreboard (derived read model)

Implemented as the `v_scoreboard` view in `db/migrations/001_init.sql`. The payload
casts are defensive on purpose: `session_events.payload` is free-form JSONB, so a
malformed or missing field must yield NULL rather than abort the whole query with
`invalid input syntax for type numeric`. One bad row must never 500 the scoreboard
for a whole session.

```sql
WITH bets AS (
  SELECT
    e.session_id,
    e.actor_user_id                          AS user_id,
    e.market_id,
    lower(btrim(e.payload->>'side'))          AS side,
    CASE WHEN (e.payload->>'amountUsdc') ~ '^[0-9]+(\.[0-9]+)?$'
         THEN (e.payload->>'amountUsdc')::NUMERIC(18,6) END AS cost_usdc,
    CASE WHEN (e.payload->>'shares') ~ '^[0-9]+(\.[0-9]+)?$'
         THEN (e.payload->>'shares')::NUMERIC(24,6) END     AS shares
  FROM session_events e
  WHERE e.type = 'trade.reported'
    AND e.actor_user_id IS NOT NULL
    AND e.market_id IS NOT NULL
    AND lower(btrim(coalesce(e.payload->>'side', ''))) IN ('yes', 'no')
)
SELECT
  b.session_id, b.user_id, u.display_name, u.wallet,
  count(*)                                                          AS bets,
  count(*) FILTER (WHERE m.resolved)                                AS resolved_bets,
  count(*) FILTER (WHERE m.resolved AND b.side = lower(m.outcome))  AS correct,
  count(*) FILTER (WHERE m.resolved AND b.side <> lower(m.outcome)) AS wrong,
  coalesce(
    sum(b.shares) FILTER (WHERE m.resolved AND b.side = lower(m.outcome))
    - sum(b.cost_usdc), 0
  )::NUMERIC(18,6)                                                  AS net_usdc
FROM bets b
JOIN users u           ON u.id = b.user_id
LEFT JOIN pulse_markets m ON m.id = b.market_id
GROUP BY b.session_id, b.user_id, u.display_name, u.wallet;
```

Every input is real Panta or chain data. Nothing here is synthesised.

⚠ **Still unvalidated.** This is a plausible reading of the shapes, not a verified
one. Budget an hour on day 11 and hand-check one session against
`GET /positions/`. A scoreboard showing wrong numbers is worse than no scoreboard.

---

## 9. Known constraints and their workarounds

| Constraint | Consequence | Workaround |
|---|---|---|
| No resolution API | Cannot demo create → resolve → claim live | Pre-create markets 24–48h before the demo with `resolutionTime` in the past; Panta's oracle resolves them. A demo wallet buys YES beforehand. Claim live against a genuinely resolved market. State this honestly in the README. |
| `imageUrl` required, catalog-only | Upload spinner in the create flow | Pre-seed ~10 1024×1024 tiles on your own CDN, map from template chips. Cloudinary path exists but is off the demo path. |
| `startTime` +3600s | Standard markets unusable in a session | Always `breaking` + `eventInProgress: true` |
| `DUPLICATE_MARKET` | Collaborative creation collides | Session dedupe → "join existing" + session nonce in `question` |
| Creation fee, real USDC | Budget risk | Confirm `paymentUsdc` on day 1. Reuse markets. Ask Panta Discord `#dev-chat` about fee sponsorship for sponsored hackathons. |
| No holders endpoint | "Who's on which side" unavailable directly | Derive from `GET /markets/{id}/trades/` — real tape, map wallet → Circle member |
| Shared per-key rate limit | One user can exhaust the budget | Token buckets + single-flight + SWR + fail-open |
| `markets/list` has no prices | Can't render from list | Always `markets/{id}` for price, cached |
| Blockhash ~60s | Mobile wallet popup can exceed it | Pre-warm, build on confirm, auto-requote on `QUOTE_STALE` |
| No testnet | All testing is mainnet real money | QuickNode **devnet** for wallet + tx-plumbing work; mainnet only for Panta calls. |
| Attribution is per API key, not per user | `createdBy=me` returns all Pulse markets | Pass `userId` on quote/build; track per-user ownership in Postgres |

---

## 10. Schedule

| Days | Focus | Gate |
|---|---|---|
| **1** | **Spike.** Register, mint key, confirm `canCreateMarkets`, read real `paymentUsdc`, fund wallets, clone `panta-api-playground`, create one breaking market end-to-end, buy YES, read positions. | If this fails, stop and reassess. |
| 2–3 | Scaffold, `lib/panta/*` (client, cache, limiter, breaker), migrations, wallet connect, **both** tx paths | Create + buy work from the UI |
| 4–5 | Circle (invite code + members), Live Session room, price cache | Session room renders live prices |
| 6–7 | Create Prediction: chips, tiles, breaking params, fee display, dedupe | Create works on stage-repeatable |
| 8–9 | Buy Yes/No, `QUOTE_STALE` retry, trade feed, attribution | Two wallets move a price |
| 10 | My Positions, claim flow | Live claim against resolved market |
| 11 | Scoreboard, Panta stats page | Both render real data |
| 12 | Mobile polish, error/empty/loading states, staleness stamp, attribution everywhere | Demo-ready |
| 13 | **Pre-create claim-demo markets** (needs 24–48h) + real-user watch party | Oracle has resolved them |
| 14 | Fix what the real users broke | |
| 15 | Rehearse 5×, record video, write README | |
| 16 | Submit | |

**Designated sacrifices if you slip:** scoreboard first, then the AI suggester, then
custom image upload. Never sacrifice: create, buy, claim, attribution, staleness stamp.

---

## 11. Demo script

1. Pre-wired Circle, 3+ funded wallets, one market already live and priced.
2. Start / join Live Session.
3. **Create a breaking market on stage** — two taps, image attached, tradeable
   immediately. *This is the moment. Rehearse it five times.*
4. Two wallets buy opposite sides → price visibly moves → trade feed updates.
5. Claim winnings against the pre-resolved market.
6. End session → scoreboard.

## 12. The one-line technical thesis

> Panta's breaking markets let us create a prediction about something happening in the
> next four minutes, and its quote→build→sign→register flow means the whole thing is
> non-custodial. We put a social layer on top: a Circle, a Live Session, and a scoreboard
> — and every price, trade, position and claim comes from the Panta API, never invented.
