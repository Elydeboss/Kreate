# Pulse

Social prediction markets for the moments your group is already arguing about.

A small group (**Circle**) opens a **Live Session** during an event. Anyone creates
a fast binary prediction; anyone buys YES/NO with USDC while the event is still
happening. A scoreboard closes it out.

**Powered by [Panta](https://panta.market)** on Solana. Every price, trade, position
and claim comes from the Panta API. Nothing is simulated.

---

## Status

The Panta integration foundation is built and type-checks. **The product UI is not
built yet.**

| Area | State |
|---|---|
| Docs (PRD, architecture, agents guide) | done |
| Postgres schema + migrations | done, not applied |
| Panta client (metering, cache, breaker, retry) | done |
| Both transaction shapes (create / buy / claim) | done |
| Idempotency on write routes | done |
| Wallet connect, Circle, Live Session, Create, Buy, Positions, Claim | **not started** |

Next task is `docs/ARCHITECTURE.md` §10, days 2–5: wallet connect, Circle, Live
Session room, and the create-prediction path.

---

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run db:migrate
npm run dev
```

You will need, before anything works:

- **A Panta API key.** `pk_test_…` and `pk_live_…` both hit the same public API —
  the prefix is a plan label, not a network. There is no Panta testnet, so
  everything is real mainnet USDC.
- **A QuickNode Solana mainnet endpoint.** The token is in the URL path, so the URL
  *is* the credential.
- **A Postgres database.**

Check the integration layer end to end:

```bash
curl -s localhost:3000/api/ops/health | jq
```

`canCreateMarkets: true` is the one field that matters. If it is false, market
creation fails and nothing else you do will matter.

---

## Docs

| File | What it is |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, scope, the explicit cut list |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The reference: Panta contract, both transaction shapes, schema, resilience layer |
| [`docs/architecture-essentials.md`](docs/architecture-essentials.md) | One page. Decisions, rejections, ranked failure modes |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Operating rules, invariants, anti-patterns, definition of done |

Read `architecture-essentials.md` first. It is the fastest route to understanding
why the code is shaped the way it is.

---

## The three things that will break

1. **Blockhash expiry (~60s).** The quote → build → sign → broadcast path must
   finish inside a minute, and a mobile wallet popup eats into it. Rehearse the
   create path five times.
2. **`DUPLICATE_MARKET`.** Panta derives the event address from question + wallet,
   so the same wallet asking the same question twice gets a 400. See
   `db/migrations/001_init.sql` on why `question` and `title` are separate columns.
3. **No resolution API.** Panta's oracle resolves markets server-side. The claim
   demo runs against markets pre-created 24–48h ahead with `resolutionTime` in the
   past. This is stated plainly in the submission rather than faked.

---

## Licence

Built for the Colosseum Crypto World's Fair hackathon.
