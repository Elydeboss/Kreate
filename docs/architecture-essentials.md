# Architecture — Essentials

One page. Decisions, rejections, and the things that will break. Full detail in
`ARCHITECTURE.md`.

---

## Shape

```
Browser ──fetch──▶ BFF (Next.js route handlers) ──X-Api-Key──▶ Panta API
  wallet signs                                     (key never leaves server)
  client broadcasts ──────────────────────────▶ QuickNode Solana mainnet
  posts sig back ──▶ BFF ──▶ /register · /submit · /trades
                     │
                     └─▶ Postgres: your domain (truth) + Panta correlation (cache)
```

One Next.js app. Route handlers **are** the backend. No separate service.

---

## The 12 decisions

| # | Decision | Why |
|---|---|---|
| 1 | **BFF, not split frontend/backend** | Key must stay server-side; shared rate budget needs one place to meter; cache needs one process to coalesce. Splitting costs CORS + 2 deploys + a contract, for one dev, for zero gain. |
| 2 | **Breaking markets only** in Live Mode | `startTime` has a 3600s floor unless `marketType: "breaking"` + `eventInProgress: true`. Standard markets are unusable mid-match. |
| 3 | **Broadcast client-side** | Signed tx never touches your server; signing and broadcast live in one place; no RPC CORS. Client posts back only the `signature`. |
| 4 | **Two tx paths, never mixed** | Create `build` → pre-assembled `VersionedTransaction`. Buy/claim `build` → raw `instructions[]` you compile. One shared helper is a bug. |
| 5 | **All Panta calls through `lib/panta/client.ts`** | Every call metered, cached, broken, logged. If a component knows the Panta URL or key, something is wrong. |
| 6 | **Lazy TTL cache + single-flight** | `markets/{id}` is the only live-price call, one per market, 120/min shared. 20s TTL; concurrent misses fold into one upstream call. |
| 7 | **In-process token buckets per rate family** | `build` is 20/min — the tight one. Fail open. `Retry-After` in seconds + jitter, never an absolute timestamp. |
| 8 | **Idempotency key on every BFF write** | Double-tap on mobile must not create two markets. Panta is already idempotent on `register`/`submit`/`trades`. |
| 9 | **Postgres = two separate domains** | Yours (circles, sessions, events) is authoritative. Panta's (markets, prices, trades) is a **cache**. Panta wins on conflict. |
| 10 | **Append-only `session_events`** | Event sourcing's actual benefit — auditable history — at Postgres cost. Scoreboard is a view over it. |
| 11 | **Attribution on every write** | `userId` on quote + build. Feeds the stats page, which is the receipt for deep integration. |
| 12 | **Vercel, no background poller** | Serverless won't hold a 20s loop. Lazy cache instead. Move to Fly/Railway only if you need real background polling. |

---

## What was rejected, and why

| Rejected | Reason |
|---|---|
| Creator fee claiming | Needs a *graduated* market. Unreachable in 16 days. |
| Content-to-Market scraping | ~2 days, third-party dep, wrong use case. → 3-hour template suggester. |
| Event sourcing / `evtstore` | Panta is the system of record, so we'd be event-sourcing a mirror of someone else's ledger. Adds MongoDB. Live UI can't absorb projection lag. **Kept the shape, dropped the library.** |
| API gateway (Kong/Envoy/APIM) | One app, one upstream. Microsoft's own guidance: evaluate whether you need it. |
| Redis rate limiter | Single instance. In-memory is sufficient. |
| API gateway + service mesh | Same. |
| Referral rewards | Non-custodial, no off-ramp, no users. Liability. |
| Roles, email invites, notifications | Invisible to judges, pure Postgres cost. The trade feed is the notification. |
| WebSockets | Client polling your own origin at 10–15s is enough for a 6-market room. |
| "Who's on which side" from local data | No holders endpoint exists. Synthesising it would misrepresent data (ToU §5). → derive from the real Panta trade tape. |

---

## Six failure modes, ranked by how often they will bite

**1. Blockhash expiry (~60s).** The quote → build → sign → broadcast path must finish
inside 60s. A mobile wallet popup eats that. *Mitigation:* quote on sheet open, build
only on confirm, pre-warm the blockhash, auto-requote once on `QUOTE_STALE`.
**Rehearse this path five times.**

**2. `DUPLICATE_MARKET`.** Event PDA derives from `question` + `wallet`. Same question
from the same wallet → `400`. Your demo breaks the second time you run it.
*Mitigation:* session dedupe → "join the existing prediction"; session nonce in
`question` (display reads clean `title`). The nonce mints a new market **and a new
creation fee** — a scalpel, not a default.

**3. `imageUrl` is mandatory.** Catalog-only, public HTTP(S), 1024×1024 recommended, no
data URLs. An upload spinner in the create flow is a dead demo moment.
*Mitigation:* pre-seed ~10 tiles on your own CDN, mapped from template chips.

**4. No resolution API.** You cannot demo create → resolve → claim live.
*Mitigation:* pre-create markets 24–48h ahead with `resolutionTime` in the past. Panta's
oracle resolves them. Buy YES beforehand, claim live on stage. Say so in the README.

**5. Shared rate limit.** Caps are per API key, shared by all users. One busy room can
exhaust the 20/min `build` budget for everyone. *Mitigation:* token buckets,
single-flight, SWR, fail open, surface `Retry-After`.

**6. Creation fees are real USDC.** Trading is cheap (~$20 total). Creation is the
budget line. *Mitigation:* read the real `paymentUsdc` on day 1, reuse markets across
demo runs, ask Panta Discord `#dev-chat` about fee sponsorship.

---

## Amount formats

| Surface | Format | Example |
|---|---|---|
| Create market | USDC **base units**, integer string | `"50000000"` = 50 USDC |
| Primary buy | Human decimal string | `"20.00"` |

Base URL `https://live-api.panta.market/api/v1`. **Trailing slash on every route.**

---

## ToU obligations that are code requirements

| Obligation | Implementation |
|---|---|
| §6 exact string "Powered by Panta", prominent, not removable | `PoweredByPanta` component in market module, trading UI, positions, session header, footer. Hardcoded — `X-Powered-By` is invisible to browsers. |
| §5 never present stale/simulated data as live | `StalenessStamp` — "prices as of HH:MM:SS" whenever the cache serves a background refresh. Required, not polish. |
| §3 no credentials in public source or frontend bundle | Server env only. Never `NEXT_PUBLIC_`. |
| §7 no wash trading / artificial volume | Only real, signed, on-chain trades reported. Nothing simulated. |
| §10 jurisdiction is the developer's problem | Framed as a group prediction surface, not a wagering product. |

---

## Data model in one line each

| Table | Role |
|---|---|
| `users` | wallet is the identity. No email, no password. |
| `circles` / `circle_members` | Invite code. That's the whole social layer. |
| `live_sessions` | `ends_at` drives every market's `endTime`. |
| `session_events` | **Append-only.** Scoreboard + activity read from it. |
| `pulse_markets` | Panta pointer + price snapshot. **Cache. Panta wins on conflict.** |
| `market_trades` | Real tape from `/markets/{id}/trades/`. Never synthesised. |
| `panta_creates` / `panta_orders` | Session correlation for the flows. |
| `idempotency_keys` | Replay protection on writes. |

Positions are **not** stored. `GET /positions/` is wallet-scoped, share-denominated,
capped ~200, and can lag. Read live, cache 30s. Compute USD client-side:
`shares × price` while open, `shares × 1` if `side === outcome` after resolution.

---

## Build order

`lib/panta` → wallet connect → both tx paths → Circle → Session room → price cache →
Create → Buy → trade feed → Positions → Claim → Scoreboard → stats → polish → real
users → README.

**Never sacrifice:** create, buy, claim, attribution, staleness stamp.
**Sacrifice in this order:** scoreboard → AI suggester → custom image upload.
