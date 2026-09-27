import { db, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'
import { appendEvents } from './events'
import { toNum } from './values'

/**
 * `market_trades` — the real on-chain tape, read from `GET /markets/{id}/trades/`.
 *
 * ⚠ NEVER SYNTHESISE A ROW IN HERE. Panta ToU §5 requires displayed market data
 * to reflect Panta's actual state, and §7 prohibits wash trading. Every row must
 * correspond to a transaction Panta reported. The only thing this module invents
 * is the `session_id` correlation, which is Pulse's own metadata and not market
 * data.
 *
 * `signature` is the primary key, which gives dedupe and idempotency for free
 * because it mirrors an actual transaction.
 */

export interface TradeRow extends QueryResultRow {
  signature: string
  panta_market_id: string
  wallet: string
  side: 'yes' | 'no' | null
  yes_amount: string
  no_amount: string
  shares: string
  fee_paid: string | null
  block_time: string | null
  quote_asset: string | null
  session_id: string | null
  fetched_at: Date
}

export interface TapeEntry {
  signature: string
  pantaMarketId: string
  wallet: string
  side: 'yes' | 'no' | null
  yesAmount: number
  noAmount: number
  shares: number
  feePaid: number | null
  blockTime: number | null
  fetchedAt: Date
}

function toEntry(row: TradeRow): TapeEntry {
  return {
    signature: row.signature,
    pantaMarketId: row.panta_market_id,
    wallet: row.wallet,
    side: row.side,
    yesAmount: toNum(row.yes_amount) ?? 0,
    noAmount: toNum(row.no_amount) ?? 0,
    shares: toNum(row.shares) ?? 0,
    feePaid: toNum(row.fee_paid),
    blockTime: row.block_time === null ? null : Number(row.block_time),
    fetchedAt: row.fetched_at,
  }
}

/**
 * A trade as Panta reported it.
 *
 * Panta's tape gives both legs of a trade as amounts, not a side. A trade that
 * bought 20 USDC of YES arrives as `yesAmount: 20, noAmount: 0`. Deriving the
 * side from which leg is non-zero is the caller's job — see `tradeSide` in
 * lib/panta/types.ts, which does it once.
 */
export interface IncomingTrade {
  signature: string
  pantaMarketId: string
  wallet: string
  yesAmount: number
  noAmount: number
  shares: number
  side?: 'yes' | 'no' | null
  feePaid?: number | null
  blockTime?: number | null
  quoteAsset?: string | null
  /** Pulse's correlation. Not market data. */
  sessionId?: string | null
}

export interface UpsertResult {
  /** How many rows were genuinely new. The caller emits events only for these. */
  inserted: number
  /** How many were already known. */
  duplicates: number
}

/**
 * Merge a fetched tape into the cache.
 *
 * ⚠ The `inserted` count is load-bearing. `session_events` is append-only, so
 * re-syncing a market would otherwise append a `trade.reported` event for every
 * trade every time, and `v_scoreboard` would count each bet several times over.
 * A scoreboard that inflates itself on every poll is worse than no scoreboard,
 * so only genuinely new signatures become events.
 *
 * `xmax = 0` is Postgres's way of saying "this INSERT produced a row" as opposed
 * to `ON CONFLICT DO NOTHING` skipping one. It is an implementation detail, but
 * it is the only way to get a true inserted/deleted distinction out of an upsert.
 */
export async function upsertTrades(
  trades: readonly IncomingTrade[],
  executor: Db = db,
): Promise<UpsertResult> {
  if (trades.length === 0) return { inserted: 0, duplicates: 0 }

  // Chunked to stay clear of Postgres's 65535 bind-parameter ceiling.
  const CHUNK = 500
  let inserted = 0

  for (let offset = 0; offset < trades.length; offset += CHUNK) {
    const chunk = trades.slice(offset, offset + CHUNK)
    const values: string[] = []
    const params: unknown[] = []

    for (const [index, trade] of chunk.entries()) {
      const base = index * 9
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::text, $${base + 5}::numeric, $${base + 6}::numeric, $${base + 7}::bigint, $${base + 8}::text, $${base + 9}::text)`,
      )
      params.push(
        trade.signature,
        trade.pantaMarketId,
        trade.wallet,
        trade.side ?? null,
        trade.yesAmount,
        trade.noAmount,
        trade.shares,
        trade.blockTime ?? null,
        trade.quoteAsset ?? null,
      )
    }

    const rows = await executor.query<{ inserted: boolean }>(
      `INSERT INTO market_trades (
         signature, panta_market_id, wallet, side, yes_amount, no_amount,
         shares, block_time, quote_asset
       )
       VALUES ${values.join(', ')}
       ON CONFLICT (signature) DO NOTHING
       RETURNING (xmax = 0) AS inserted`,
      params,
    )
    inserted += rows.length
  }

  return { inserted, duplicates: trades.length - inserted }
}

/**
 * Record the fetched-at time for every trade on a market.
 *
 * Separate from the insert because it runs on every sync, while inserts only
 * happen for new signatures. Without it there is no way to tell "Panta has
 * nothing new" from "we stopped syncing", which is the difference between a
 * quiet market and a broken poller.
 */
export async function touchTrades(
  pantaMarketId: string,
  executor: Db = db,
): Promise<number> {
  const rows = await executor.query<{ signature: string }>(
    `UPDATE market_trades
        SET fetched_at = now()
      WHERE panta_market_id = $1
      RETURNING signature`,
    [pantaMarketId],
  )
  return rows.length
}

/** Correlate a market's existing trades to a session. Idempotent. */
export async function assignTradesToSession(
  pantaMarketId: string,
  sessionId: string,
  executor: Db = db,
): Promise<number> {
  const rows = await executor.query<{ signature: string }>(
    `UPDATE market_trades
        SET session_id = $2
      WHERE panta_market_id = $1 AND session_id IS NULL
      RETURNING signature`,
    [pantaMarketId, sessionId],
  )
  return rows.length
}

const TAPE_COLUMNS = `
  signature, panta_market_id, wallet, side, yes_amount, no_amount,
  shares, fee_paid, block_time, quote_asset, session_id, fetched_at`

/** The tape for one market, newest first. */
export async function listMarketTrades(
  pantaMarketId: string,
  limit = 50,
  executor: Db = db,
): Promise<TapeEntry[]> {
  const rows = await executor.query<TradeRow>(
    `SELECT ${TAPE_COLUMNS}
       FROM market_trades
      WHERE panta_market_id = $1
      ORDER BY block_time DESC NULLS LAST, signature DESC
      LIMIT $2`,
    [pantaMarketId, Math.min(Math.max(limit, 1), 200)],
  )
  return rows.map(toEntry)
}

/** The tape across a whole session, newest first. This is the room's activity feed. */
export async function listSessionTrades(
  sessionId: string,
  limit = 50,
  executor: Db = db,
): Promise<TapeEntry[]> {
  const rows = await executor.query<TradeRow>(
    `SELECT ${TAPE_COLUMNS}
       FROM market_trades
      WHERE session_id = $1
      ORDER BY block_time DESC NULLS LAST, signature DESC
      LIMIT $2`,
    [sessionId, Math.min(Math.max(limit, 1), 200)],
  )
  return rows.map(toEntry)
}

/** Trades by one wallet across a session. Used to render "your position". */
export async function listWalletTrades(
  wallet: string,
  sessionId?: string,
  limit = 50,
  executor: Db = db,
): Promise<TapeEntry[]> {
  const rows = sessionId
    ? await executor.query<TradeRow>(
        `SELECT ${TAPE_COLUMNS}
           FROM market_trades
          WHERE wallet = $1 AND session_id = $2
          ORDER BY block_time DESC NULLS LAST, signature DESC
          LIMIT $3`,
        [wallet, sessionId, Math.min(Math.max(limit, 1), 200)],
      )
    : await executor.query<TradeRow>(
        `SELECT ${TAPE_COLUMNS}
           FROM market_trades
          WHERE wallet = $1
          ORDER BY block_time DESC NULLS LAST, signature DESC
          LIMIT $2`,
        [wallet, Math.min(Math.max(limit, 1), 200)],
      )
  return rows.map(toEntry)
}

/** Trade count for a market, without fetching the rows. */
export async function countTrades(pantaMarketId: string, executor: Db = db): Promise<number> {
  const row = await executor.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM market_trades WHERE panta_market_id = $1`,
    [pantaMarketId],
  )
  return row ? Number(row.count) : 0
}

/** Has this signature already been recorded? Cheap pre-check before an event append. */
export async function tradeExists(signature: string, executor: Db = db): Promise<boolean> {
  const row = await executor.queryOne<{ present: boolean }>(
    `SELECT true AS present FROM market_trades WHERE signature = $1`,
    [signature],
  )
  return row !== null
}

// ── Tape sync ───────────────────────────────────────────────────────────────

export interface SyncResult {
  /** Trades genuinely new to us. */
  inserted: number
  /** Ledger events appended. Equals `inserted` minus trades from unknown wallets. */
  eventsAppended: number
  /** Trades dropped because no Pulse user owns that wallet. See below. */
  unattributed: number
}

/**
 * Merge a fetched tape and append the matching ledger events — atomically.
 *
 * THIS FUNCTION IS WHY THE SCOREBOARD CANNOT BE FORGED. It is the only place a
 * `trade.reported` event is created, and `actor_user_id` is resolved by looking
 * up the trade's OWN `wallet` field — the one Panta reported — against `users`.
 * It is never taken from the request that happened to trigger the sync. A caller
 * who forges their identity header can therefore make their own fake bet
 * invisible; they cannot make someone else's real bet appear, and they cannot
 * invent a bet at all, because there has to be a real signature that Panta
 * reported. See server/identity.ts for the rest of that argument.
 *
 * ⚠ Only genuinely new signatures become events. `upsertTrades` returns a true
 * inserted count precisely so this can be enforced: since the ledger is
 * append-only, re-syncing a market would otherwise append an event for every
 * known trade on every poll, and `v_scoreboard` would count each bet once per
 * poll forever.
 *
 * Trades from wallets with no `users` row are counted as unattributed and no
 * event is written. That is a stranger trading on a public market, not a member
 * of the session, and `v_scoreboard` filters null actors out anyway. Creating a
 * user row for them would put an unclaimed identity into the member list.
 */
export async function syncMarketTape(
  trades: readonly IncomingTrade[],
  context: { pulseMarketId: string; sessionId: string | null },
  executor: Db = db,
): Promise<SyncResult> {
  if (trades.length === 0) return { inserted: 0, eventsAppended: 0, unattributed: 0 }

  // Which of these signatures are new? `upsertTrades` returns a count rather
  // than a set, so resolve the set first. Re-checking inside the same
  // transaction is safe because the tape and the ledger are written together.
  const signatures = trades.map((t) => t.signature)
  const alreadyKnown = await executor.query<{ signature: string }>(
    `SELECT signature FROM market_trades WHERE signature = ANY($1::text[])`,
    [signatures],
  )
  const known = new Set(alreadyKnown.map((row) => row.signature))
  const fresh = trades.filter((t) => !known.has(t.signature))

  const { inserted } = await upsertTrades(fresh, executor)
  if (inserted === 0 || !context.sessionId) {
    return { inserted, eventsAppended: 0, unattributed: 0 }
  }
  const sessionId = context.sessionId

  // Resolve actors from the tape's own wallets, never from the caller.
  const wallets = [...new Set(fresh.map((t) => t.wallet))]
  const users = await executor.query<{ id: string; wallet: string }>(
    `SELECT id, wallet FROM users WHERE wallet = ANY($1::text[])`,
    [wallets],
  )
  const userByWallet = new Map(users.map((row) => [row.wallet, row.id]))

  const events = fresh
    .map((trade) => {
      const actorUserId = userByWallet.get(trade.wallet)
      if (!actorUserId) return null
      const side = trade.side ?? deriveSide(trade.yesAmount, trade.noAmount)
      // A trade with no derivable side cannot be scored, and `v_scoreboard` would
      // ignore it anyway. Emitting it would be a row claiming to have been
      // usable when it was not.
      if (!side) return null

      return {
        sessionId,
        type: 'trade.reported' as const,
        actorUserId,
        // Not optional. `v_scoreboard` filters on `market_id IS NOT NULL`, and it
        // has to be the Pulse row so the outcome can be joined against.
        marketId: context.pulseMarketId,
        payload: {
          side,
          // `v_scoreboard` reads these two keys and casts them with a regex
          // guard. Format matters: a float would serialise as 1e-7 and fail that
          // regex, silently dropping the bet from the leaderboard.
          amountUsdc: formatUsdc(Math.max(trade.yesAmount, trade.noAmount)),
          shares: formatUsdc(trade.shares),
          signature: trade.signature,
        },
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  if (events.length > 0) await appendEvents(events, executor)

  return {
    inserted,
    eventsAppended: events.length,
    unattributed: fresh.length - events.length,
  }
}

/**
 * Which side a Panta trade was on, from the two legs.
 *
 * Panta's tape reports both legs as amounts rather than a side, so the side is
 * whichever leg is non-zero. `tradeSide` in lib/panta/types.ts does the same for
 * a raw API response; this copy takes a plain object so this module stays
 * free of the Panta client.
 */
function deriveSide(yesAmount: number, noAmount: number): 'yes' | 'no' | null {
  if (yesAmount > 0 && noAmount <= 0) return 'yes'
  if (noAmount > 0 && yesAmount <= 0) return 'no'
  // Both legs non-zero is a market-order fill that crossed. Treat it as
  // unattributable rather than guessing — see the filter above.
  return null
}

/**
 * Format a USDC amount for a NUMERIC-cast JSONB payload.
 *
 * Plain decimal notation, no exponent, no thousands separator. `v_scoreboard`
 * guards with `^[0-9]+(\.[0-9]+)?$`, so `1e-7` or `1,000` would be silently
 * dropped. `toFixed(6)` matches the column's own scale and is enough precision
 * for a position size.
 */
function formatUsdc(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0.000000'
  return value.toFixed(6)
}
