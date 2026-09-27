-- Pulse — initial schema
-- Apply in order:  npm run db:migrate
--
-- Governing rule (ARCHITECTURE.md §4.1):
--   Your domain (circles, sessions, events) is AUTHORITATIVE.
--   Panta's domain (markets, prices, trades) is a CACHE. Panta wins on conflict.
--   If a pulse_markets row disagrees with GET /markets/{id}/, refresh the cache.
--
-- This is the executable form of docs/ARCHITECTURE.md §4.2.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ══════════════════════════════════════════════════════════════════════════
-- Your domain — authoritative
-- ══════════════════════════════════════════════════════════════════════════

-- Wallet is the identity. No email, no password, no reset token — those were
-- deliberately cut (PRD §6) and leaving the columns out is what stops them
-- creeping back in under deadline pressure.
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet        TEXT UNIQUE NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The entire social layer is an invite code. No roles (cut), no email invites (cut).
CREATE TABLE circles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT UNIQUE NOT NULL CHECK (code ~ '^[A-Z0-9]{5,8}$'),
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON circles (created_by, created_at DESC);

CREATE TABLE circle_members (
  circle_id  UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);
CREATE INDEX ON circle_members (user_id);

-- ends_at is load-bearing: it is the single source for every market's endTime,
-- so all markets in a session close together and the scoreboard has a boundary.
CREATE TABLE live_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id   UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  stream_url  TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at     TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  CHECK (ends_at > started_at)
);
CREATE INDEX ON live_sessions (circle_id, started_at DESC);
CREATE INDEX ON live_sessions (status, ends_at) WHERE status = 'active';

-- APPEND-ONLY LEDGER. Insert only — never update, never delete.
-- The scoreboard and the activity feed are derived read models over this table.
-- This is the shape event sourcing would give you, at Postgres cost and without
-- a second database. See ARCHITECTURE.md §4.5 for why evtstore itself was rejected.
--
--   type: session.started | market.created | market.registered
--       | trade.reported | claim.reported | market.resolved | session.ended
CREATE TABLE session_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN (
                  'session.started', 'market.created', 'market.registered',
                  'trade.reported', 'claim.reported', 'market.resolved', 'session.ended'
                )),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  market_id     UUID,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON session_events (session_id, id DESC);
CREATE INDEX ON session_events (market_id, id DESC) WHERE market_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- Panta correlation — CACHE AND POINTER, NEVER AUTHORITATIVE
-- ══════════════════════════════════════════════════════════════════════════

-- question and title are deliberately separate columns and MUST NOT be merged.
--
--   Panta derives the event PDA from (question, wallet), so repeating a question
--   from the same wallet returns 400 DUPLICATE_MARKET. `question` therefore carries
--   a session nonce (e.g. "Goal before half-time? [AB3XQ#12]") to keep demo runs
--   re-runnable. `title` stays clean because the UI reads title, while
--   uniqueness reads question. See ARCHITECTURE.md §4.3.
CREATE TABLE pulse_markets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panta_market_id    TEXT UNIQUE,               -- event PDA; NULL until registered
  circle_id          UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  session_id         UUID REFERENCES live_sessions(id) ON DELETE CASCADE,
  created_by         UUID NOT NULL REFERENCES users(id),

  question           TEXT NOT NULL,
  title              TEXT NOT NULL,
  resolution_rule    TEXT NOT NULL,
  sources_of_truth   TEXT[] NOT NULL,
  category           TEXT NOT NULL CHECK (category IN (
                       'sports','crypto','politics','entertainment',
                       'finance','science','world','other')),
  image_url          TEXT NOT NULL,             -- required by Panta; pre-seeded tile
  market_type        TEXT NOT NULL DEFAULT 'breaking'
                       CHECK (market_type IN ('standard', 'breaking')),

  -- Snapshot, refreshed from GET /markets/{id}/. prices_as_of and snapshot_at
  -- make staleness visible in the data, not just in a comment. They are what
  -- drives the StalenessStamp required by Panta ToU §5.
  phase              TEXT CHECK (phase IN ('primary', 'secondary', 'resolved', 'cancelled')),
  resolved           BOOLEAN NOT NULL DEFAULT false,
  outcome            TEXT CHECK (outcome IN ('yes', 'no')),
  yes_price          NUMERIC(6,4) CHECK (yes_price IS NULL OR yes_price BETWEEN 0 AND 1),
  no_price           NUMERIC(6,4) CHECK (no_price  IS NULL OR no_price  BETWEEN 0 AND 1),
  volume_usdc        NUMERIC(18,6),
  prices_as_of       TIMESTAMPTZ,
  snapshot_at        TIMESTAMPTZ,

  start_time         BIGINT NOT NULL,
  end_time           BIGINT NOT NULL,
  resolution_time    BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (end_time > start_time),
  CHECK (resolution_time >= end_time)
);
CREATE INDEX ON pulse_markets (session_id, created_at DESC);
CREATE INDEX ON pulse_markets (circle_id, created_at DESC);
-- Backs the session-level "is there already an open market for this question?" check.
CREATE UNIQUE INDEX ON pulse_markets (session_id, lower(question))
  WHERE resolved = false AND panta_market_id IS NOT NULL;

-- Real on-chain flow, read from GET /markets/{id}/trades/. Never synthesised.
-- signature as PK gives free idempotency and natural dedupe, because it mirrors
-- an actual transaction. Sourcing this table from anything else would violate
-- Panta ToU §5 and §7.
CREATE TABLE market_trades (
  signature        TEXT PRIMARY KEY,
  panta_market_id  TEXT NOT NULL,
  wallet           TEXT NOT NULL,
  side             TEXT CHECK (side IN ('yes', 'no')),
  yes_amount       NUMERIC(24,6) NOT NULL DEFAULT 0,
  no_amount        NUMERIC(24,6) NOT NULL DEFAULT 0,
  shares           NUMERIC(24,6) NOT NULL,
  fee_paid         NUMERIC(18,6),
  block_time       BIGINT,
  quote_asset      TEXT,
  session_id       UUID REFERENCES live_sessions(id) ON DELETE SET NULL,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON market_trades (panta_market_id, block_time DESC);
CREATE INDEX ON market_trades (session_id, block_time DESC);
CREATE INDEX ON market_trades (wallet, block_time DESC);

-- Session correlation for in-flight Panta flows. Exists so a crashed run can be
-- reconciled: "did that createId ever land on chain?"
CREATE TABLE panta_creates (
  create_id          TEXT PRIMARY KEY,
  pulse_market_id    UUID NOT NULL REFERENCES pulse_markets(id) ON DELETE CASCADE,
  wallet             TEXT NOT NULL,
  payment_usdc       TEXT,                    -- raw string from the quote, as returned
  expected_event_pda TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'registered', 'failed', 'expired')),
  signature          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON panta_creates (pulse_market_id);
CREATE INDEX ON panta_creates (wallet, created_at DESC);

CREATE TABLE panta_orders (
  order_id        TEXT PRIMARY KEY,
  quote_id        TEXT,
  pulse_market_id UUID NOT NULL REFERENCES pulse_markets(id) ON DELETE CASCADE,
  wallet          TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  amount_usdc     TEXT NOT NULL,              -- decimal string, e.g. "20.00"
  status          TEXT NOT NULL DEFAULT 'built'
                    CHECK (status IN ('built', 'submitted', 'confirmed', 'failed', 'expired')),
  signature       TEXT,
  user_id         TEXT,                       -- Panta attribution id (not a FK)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, signature)
);
CREATE INDEX ON panta_orders (wallet, created_at DESC);
CREATE INDEX ON panta_orders (status, created_at DESC) WHERE status IN ('built', 'submitted');

-- Replay protection on BFF write routes. Insert the key row BEFORE the side
-- effect so a crash mid-write cannot double-create.
-- Same key + same hash  -> replay the stored response.
-- Same key + diff hash  -> 409.
CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  route        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INT NOT NULL,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON idempotency_keys (created_at);

-- ══════════════════════════════════════════════════════════════════════════
-- Derived read models
-- ══════════════════════════════════════════════════════════════════════════

-- Session leaderboard: who called it, who didn't, net USDC.
--
-- ⚠ ILLUSTRATIVE, NOT YET VALIDATED AGAINST REAL DATA. Budget an hour on
-- schedule day 11 to make this produce correct numbers, and hand-check one
-- session against GET /positions/. A scoreboard showing wrong numbers is worse
-- than no scoreboard. See ARCHITECTURE.md §8.4.
--
-- Every input here is real Panta or chain data. Nothing is synthesised.
--
-- The payload casts are defensive on purpose. `payload` is free-form JSONB, so
-- a malformed or missing field must yield NULL, not abort the whole query with
-- "invalid input syntax for type numeric" — one bad row must not 500 the
-- scoreboard for an entire session.
CREATE VIEW v_scoreboard AS
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
  b.session_id,
  b.user_id,
  u.display_name,
  u.wallet,
  count(*)                                                             AS bets,
  count(*) FILTER (WHERE m.resolved)                                   AS resolved_bets,
  count(*) FILTER (WHERE m.resolved AND b.side = lower(m.outcome))     AS correct,
  count(*) FILTER (WHERE m.resolved AND b.side <> lower(m.outcome))    AS wrong,
  coalesce(
    sum(b.shares) FILTER (WHERE m.resolved AND b.side = lower(m.outcome))
    - sum(b.cost_usdc),
    0
  )::NUMERIC(18,6)                                                    AS net_usdc
FROM bets b
JOIN users u           ON u.id = b.user_id
LEFT JOIN pulse_markets m ON m.id = b.market_id
GROUP BY b.session_id, b.user_id, u.display_name, u.wallet;

-- Convenience: active markets in a session, ordered for the room UI.
CREATE VIEW v_session_markets AS
SELECT
  m.id,
  m.panta_market_id,
  m.session_id,
  m.circle_id,
  m.title,
  m.question,
  m.category,
  m.image_url,
  m.phase,
  m.resolved,
  m.outcome,
  m.yes_price,
  m.no_price,
  m.volume_usdc,
  m.prices_as_of,
  m.end_time,
  m.created_by,
  m.created_at,
  (SELECT count(*) FROM market_trades t WHERE t.panta_market_id = m.panta_market_id) AS trade_count
FROM pulse_markets m
WHERE m.panta_market_id IS NOT NULL;
