import { db, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'
import { toNum } from './values'

/**
 * `pulse_markets` — a CACHE of Panta's market state, plus the app-level metadata
 * Panta has no concept of.
 *
 * ⚠ THIS DOMAIN IS NOT AUTHORITATIVE (ARCHITECTURE.md §4.1). If a row here
 * disagrees with `GET /markets/{id}/`, Panta is right. Refresh the cache. Never
 * resolve a disagreement in the database, and never show a cached value to a
 * user without the staleness stamp Panta ToU §5 requires.
 *
 * The columns Panta owns are `phase`, `resolved`, `outcome`, the prices, the
 * volume, and the three timestamps. The columns Pulse owns are `question`,
 * `title`, `session_id`, `circle_id`, and `created_by`.
 */

export type MarketCategory =
  | 'sports'
  | 'crypto'
  | 'politics'
  | 'entertainment'
  | 'finance'
  | 'science'
  | 'world'
  | 'other'

export type MarketPhase = 'primary' | 'secondary' | 'resolved' | 'cancelled'

/** Panta's allowlist. Anything outside it is rejected at quote time, so we check. */
export const MARKET_CATEGORIES: readonly MarketCategory[] = [
  'sports',
  'crypto',
  'politics',
  'entertainment',
  'finance',
  'science',
  'world',
  'other',
]

export function isMarketCategory(value: string): value is MarketCategory {
  return (MARKET_CATEGORIES as readonly string[]).includes(value)
}

export interface MarketRow extends QueryResultRow {
  id: string
  panta_market_id: string | null
  circle_id: string
  session_id: string | null
  created_by: string
  question: string
  title: string
  resolution_rule: string
  sources_of_truth: string[]
  category: MarketCategory
  image_url: string
  market_type: 'standard' | 'breaking'
  phase: MarketPhase | null
  resolved: boolean
  outcome: 'yes' | 'no' | null
  yes_price: string | null
  no_price: string | null
  volume_usdc: string | null
  prices_as_of: Date | null
  snapshot_at: Date | null
  start_time: string
  end_time: string
  resolution_time: string
  created_at: Date
}

export interface Market {
  id: string
  pantaMarketId: string | null
  circleId: string
  sessionId: string | null
  createdBy: string
  /** The nonce-bearing string sent to Panta. Never shown to a user. */
  question: string
  /** The clean display string. This is what the UI renders. */
  title: string
  resolutionRule: string
  sourcesOfTruth: string[]
  category: MarketCategory
  imageUrl: string
  marketType: 'standard' | 'breaking'
  phase: MarketPhase | null
  resolved: boolean
  outcome: 'yes' | 'no' | null
  /** 0..1. From Panta, not computed here. */
  yesPrice: number | null
  noPrice: number | null
  volumeUsdc: number | null
  /** When Panta answered. Drives the ToU §5 staleness stamp. */
  pricesAsOf: Date | null
  snapshotAt: Date | null
  /** Unix seconds. */
  startTime: number
  endTime: number
  resolutionTime: number
  createdAt: Date
}

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    pantaMarketId: row.panta_market_id,
    circleId: row.circle_id,
    sessionId: row.session_id,
    createdBy: row.created_by,
    question: row.question,
    title: row.title,
    resolutionRule: row.resolution_rule,
    sourcesOfTruth: row.sources_of_truth ?? [],
    category: row.category,
    imageUrl: row.image_url,
    marketType: row.market_type,
    phase: row.phase,
    resolved: row.resolved,
    outcome: row.outcome,
    yesPrice: toNum(row.yes_price),
    noPrice: toNum(row.no_price),
    volumeUsdc: toNum(row.volume_usdc),
    pricesAsOf: row.prices_as_of,
    snapshotAt: row.snapshot_at,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    resolutionTime: Number(row.resolution_time),
    createdAt: row.created_at,
  }
}

const SELECT_COLUMNS = `
  id, panta_market_id, circle_id, session_id, created_by, question, title,
  resolution_rule, sources_of_truth, category, image_url, market_type,
  phase, resolved, outcome, yes_price, no_price, volume_usdc,
  prices_as_of, snapshot_at, start_time, end_time, resolution_time, created_at`

export interface NewMarket {
  circleId: string
  sessionId?: string | null
  createdBy: string
  /** Nonce-bearing. See `nonceQuestion` below. */
  question: string
  title: string
  resolutionRule: string
  sourcesOfTruth: string[]
  category: MarketCategory
  imageUrl: string
  marketType?: 'standard' | 'breaking'
  startTime: number
  endTime: number
  resolutionTime: number
}

/**
 * Append a session nonce to a question so the same prediction can be minted twice.
 *
 * Panta derives the event PDA from (question, wallet), so the same wallet asking
 * the same question twice returns 400 DUPLICATE_MARKET. Demo runs need to be
 * re-runnable, and a user genuinely re-asking a question mid-session should be
 * offered the existing market rather than a dead end.
 *
 * The nonce goes in `question`, never in `title`: the UI reads title, so what a
 * user sees stays clean while uniqueness is preserved. Same market, same fee —
 * this is a scalpel for re-runs, not the default path. See ARCHITECTURE.md §4.3.
 */
export function nonceQuestion(question: string, nonce: string): string {
  return `${question} [${nonce}]`
}

/**
 * Find an open market in this session with the same question.
 *
 * The app-layer half of the DUPLICATE_MARKET workaround. When this returns a
 * row, the right answer is to offer the user the existing market, not to mint a
 * new one — and minting a new one costs a real fee.
 *
 * Matches on the clean title rather than the nonce-bearing question, because
 * that is the thing the user actually typed and the thing they would recognise.
 */
export async function findOpenMarketByTitle(
  sessionId: string,
  title: string,
  executor: Db = db,
): Promise<Market | null> {
  const row = await executor.queryOne<MarketRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM pulse_markets
      WHERE session_id = $1
        AND lower(btrim(title)) = lower(btrim($2))
        AND resolved = false
        AND panta_market_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId, title],
  )
  return row ? toMarket(row) : null
}

/**
 * Record a market we are about to create on Panta.
 *
 * Written BEFORE the Panta quote, with `panta_market_id` still null. That
 * ordering is what makes a crash recoverable: the row plus its `panta_creates`
 * entry tell us a create was attempted, and `createId` tells us whether it
 * landed. A create that is only recorded after success leaves nothing behind
 * when it fails, which is exactly the case you need to debug.
 */
export async function insertMarket(input: NewMarket, executor: Db = db): Promise<Market> {
  const row = await executor.queryOne<MarketRow>(
    `INSERT INTO pulse_markets (
       circle_id, session_id, created_by, question, title, resolution_rule,
       sources_of_truth, category, image_url, market_type,
       start_time, end_time, resolution_time
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.circleId,
      input.sessionId ?? null,
      input.createdBy,
      input.question,
      input.title,
      input.resolutionRule,
      input.sourcesOfTruth,
      input.category,
      input.imageUrl,
      input.marketType ?? 'breaking',
      input.startTime,
      input.endTime,
      input.resolutionTime,
    ],
  )
  if (!row) throw new Error('market insert returned no row')
  return toMarket(row)
}

/**
 * Attach the Panta event PDA once the create has been registered on chain.
 *
 * Guarded on `panta_market_id IS NULL` so a retried registration cannot
 * repoint a market that is already live — the trade tape is keyed on this value,
 * and silently moving it would orphan real trades.
 */
export async function attachPantaMarketId(
  pulseMarketId: string,
  pantaMarketId: string,
  executor: Db = db,
): Promise<Market | null> {
  const row = await executor.queryOne<MarketRow>(
    `UPDATE pulse_markets
        SET panta_market_id = $2
      WHERE id = $1 AND panta_market_id IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [pulseMarketId, pantaMarketId],
  )
  return row ? toMarket(row) : null
}

export interface PriceSnapshot {
  phase?: MarketPhase | null
  resolved?: boolean
  outcome?: 'yes' | 'no' | null
  /** 0..1 as a number or a decimal string. */
  yesPrice?: number | string | null
  noPrice?: number | string | null
  volumeUsdc?: number | string | null
  /** When Panta answered. Required. Without it the staleness stamp is a lie. */
  pricesAsOf: Date
}

/**
 * Overwrite the Panta-owned columns with a fresh snapshot.
 *
 * An UPDATE, not a merge: these columns are Panta's to define, so a field Panta
 * stopped returning must be nulled rather than left holding a value from a
 * previous fetch. Stale fields that look current are worse than missing ones.
 */
export async function updatePriceSnapshot(
  pulseMarketId: string,
  snapshot: PriceSnapshot,
  executor: Db = db,
): Promise<Market | null> {
  const row = await executor.queryOne<MarketRow>(
    `UPDATE pulse_markets
        SET phase          = $2::text,
            resolved       = $3,
            outcome        = $4::text,
            yes_price      = $5::numeric,
            no_price       = $6::numeric,
            volume_usdc    = $7::numeric,
            prices_as_of   = $8,
            snapshot_at    = now()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}`,
    [
      pulseMarketId,
      snapshot.phase ?? null,
      snapshot.resolved ?? false,
      snapshot.outcome ?? null,
      snapshot.yesPrice ?? null,
      snapshot.noPrice ?? null,
      snapshot.volumeUsdc ?? null,
      snapshot.pricesAsOf.toISOString(),
    ],
  )
  return row ? toMarket(row) : null
}

/**
 * Mark a market resolved locally.
 *
 * A convenience over `updatePriceSnapshot` for the case where resolution is
 * observed rather than fetched. Note that Panta has NO resolution API: resolution
 * is oracle-driven and server-side, so this is called after reading a market
 * detail response and observing the outcome — it is not how resolution happens.
 */
export async function markResolved(
  pulseMarketId: string,
  outcome: 'yes' | 'no',
  pricesAsOf: Date,
  executor: Db = db,
): Promise<Market | null> {
  return updatePriceSnapshot(
    pulseMarketId,
    { phase: 'resolved', resolved: true, outcome, pricesAsOf },
    executor,
  )
}

export async function findMarketById(id: string, executor: Db = db): Promise<Market | null> {
  const row = await executor.queryOne<MarketRow>(
    `SELECT ${SELECT_COLUMNS} FROM pulse_markets WHERE id = $1`,
    [id],
  )
  return row ? toMarket(row) : null
}

export async function findMarketByPantaId(
  pantaMarketId: string,
  executor: Db = db,
): Promise<Market | null> {
  const row = await executor.queryOne<MarketRow>(
    `SELECT ${SELECT_COLUMNS} FROM pulse_markets WHERE panta_market_id = $1`,
    [pantaMarketId],
  )
  return row ? toMarket(row) : null
}

/**
 * What the room actually needs per market.
 *
 * A narrower shape than `Market` on purpose. The room renders a title, a price,
 * a phase, and a trade count — it never needs `resolution_rule` or
 * `sources_of_truth`, both of which are long strings. Selecting them for every
 * market on every poll would be pure payload, and returning a `Market` with
 * `startTime: 0` would be a lie that a caller could act on.
 */
export interface SessionMarket {
  id: string
  pantaMarketId: string
  sessionId: string
  circleId: string
  title: string
  category: MarketCategory
  imageUrl: string
  phase: MarketPhase | null
  resolved: boolean
  outcome: 'yes' | 'no' | null
  yesPrice: number | null
  noPrice: number | null
  volumeUsdc: number | null
  pricesAsOf: Date | null
  endTime: number
  createdBy: string
  createdAt: Date
  tradeCount: number
}

/**
 * Markets in a session, from the `v_session_markets` view.
 *
 * The view already filters to registered markets, so nothing half-created can
 * appear in a room, and it carries a trade count for the room UI.
 */
export async function listSessionMarkets(sessionId: string, executor: Db = db): Promise<SessionMarket[]> {
  const rows = await executor.query<
    QueryResultRow & {
      id: string
      panta_market_id: string
      session_id: string
      circle_id: string
      title: string
      category: MarketCategory
      image_url: string
      phase: MarketPhase | null
      resolved: boolean
      outcome: 'yes' | 'no' | null
      yes_price: string | null
      no_price: string | null
      volume_usdc: string | null
      prices_as_of: Date | null
      end_time: string
      created_by: string
      created_at: Date
      trade_count: string
    }
  >(
    `SELECT id, panta_market_id, session_id, circle_id, title, category,
            image_url, phase, resolved, outcome, yes_price, no_price, volume_usdc,
            prices_as_of, end_time, created_by, created_at, trade_count
       FROM v_session_markets
      WHERE session_id = $1
      ORDER BY created_at ASC`,
    [sessionId],
  )
  return rows.map((row) => ({
    id: row.id,
    pantaMarketId: row.panta_market_id,
    sessionId: row.session_id,
    circleId: row.circle_id,
    title: row.title,
    category: row.category,
    imageUrl: row.image_url,
    phase: row.phase,
    resolved: row.resolved,
    outcome: row.outcome,
    yesPrice: toNum(row.yes_price),
    noPrice: toNum(row.no_price),
    volumeUsdc: toNum(row.volume_usdc),
    pricesAsOf: row.prices_as_of,
    endTime: Number(row.end_time),
    createdBy: row.created_by,
    createdAt: row.created_at,
    tradeCount: Number(row.trade_count),
  }))
}

/** Mark a market's `panta_creates` row as failed, so a stale attempt is visible. */
export async function markMarketFailed(
  pulseMarketId: string,
  executor: Db = db,
): Promise<void> {
  // Not a delete. An abandoned create is evidence: without it, "why does this
  // market have no Panta id" has no answer.
  await executor.query(`UPDATE pulse_markets SET panta_market_id = NULL WHERE id = $1`, [pulseMarketId])
}

/** Count of markets in a session that are registered with Panta. */
export async function countRegisteredMarkets(
  sessionId: string,
  executor: Db = db,
): Promise<number> {
  const row = await executor.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pulse_markets
      WHERE session_id = $1 AND panta_market_id IS NOT NULL`,
    [sessionId],
  )
  return row ? Number(row.count) : 0
}
