import { db, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'
import { toNumOrZero } from './values'

/**
 * The session scoreboard, read from `v_scoreboard`.
 *
 * ⚠ NOT YET VALIDATED. The view is marked ILLUSTRATIVE in the migration and its
 * arithmetic has never been checked against `GET /positions/`. Budget an hour on
 * schedule day 11 to hand-check one session. A leaderboard showing wrong numbers
 * is worse than no leaderboard, because people believe leaderboards.
 *
 * Every input is real: `session_events` rows are appended from Panta's own trade
 * tape, and outcomes come from `pulse_markets.resolved` / `.outcome`, which are
 * Panta's. Nothing here is synthesised, so the numbers are defensible even where
 * the formula is not yet right.
 */

export interface ScoreboardRow extends QueryResultRow {
  session_id: string
  user_id: string
  display_name: string | null
  wallet: string
  bets: string
  resolved_bets: string
  correct: string
  wrong: string
  net_usdc: string
}

export interface ScoreboardRow_ {
  userId: string
  wallet: string
  displayName: string | null
  bets: number
  resolvedBets: number
  correct: number
  wrong: number
  /** Net USDC. Positive is good. Zero if nothing has resolved yet. */
  netUsdc: number
}

function toScore(row: ScoreboardRow): ScoreboardRow_ {
  return {
    userId: row.user_id,
    wallet: row.wallet,
    displayName: row.display_name,
    bets: Number(row.bets),
    resolvedBets: Number(row.resolved_bets),
    correct: Number(row.correct),
    wrong: Number(row.wrong),
    netUsdc: toNumOrZero(row.net_usdc),
  }
}

/**
 * The leaderboard for a session, best net USDC first.
 *
 * Ties break on correct count and then on name, so the ordering is stable across
 * polls. An unstable order makes rows jump around between refreshes, which reads
 * as the numbers changing when they have not.
 *
 * Note that `net_usdc` stays 0 until markets resolve — the view only nets a bet
 * once its market has an outcome. A session with no resolved markets therefore
 * returns rows that are all zero, and the UI must say "no results yet" rather
 * than showing a wall of 0.00s.
 */
export async function getScoreboard(sessionId: string, executor: Db = db): Promise<ScoreboardRow_[]> {
  const rows = await executor.query<ScoreboardRow>(
    `SELECT session_id, user_id, display_name, wallet,
            bets, resolved_bets, correct, wrong, net_usdc
       FROM v_scoreboard
      WHERE session_id = $1
      ORDER BY net_usdc DESC, correct DESC, coalesce(display_name, wallet) ASC`,
    [sessionId],
  )
  return rows.map(toScore)
}

/**
 * A single user's standing.
 *
 * Null when they have no reported trades in the session, which is a real state —
 * somebody joined but never called anything — and must not render as a zero row
 * implying they bet and lost nothing.
 */
export async function getUserScore(
  sessionId: string,
  userId: string,
  executor: Db = db,
): Promise<ScoreboardRow_ | null> {
  const row = await executor.queryOne<ScoreboardRow>(
    `SELECT session_id, user_id, display_name, wallet,
            bets, resolved_bets, correct, wrong, net_usdc
       FROM v_scoreboard
      WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  )
  return row ? toScore(row) : null
}

/** True when at least one market in the session has resolved. */
export async function hasResolvedMarkets(sessionId: string, executor: Db = db): Promise<boolean> {
  const row = await executor.queryOne<{ present: boolean }>(
    `SELECT true AS present
       FROM pulse_markets
      WHERE session_id = $1 AND resolved = true
      LIMIT 1`,
    [sessionId],
  )
  return row !== null
}

/** Markets in a session that have resolved, newest first. Feeds the "results" panel. */
export interface ResolvedMarket {
  pulseMarketId: string
  title: string
  outcome: 'yes' | 'no'
  resolvedAt: Date | null
}

export async function listResolvedMarkets(
  sessionId: string,
  executor: Db = db,
): Promise<ResolvedMarket[]> {
  const rows = await executor.query<
    QueryResultRow & { panta_market_id: string; title: string; outcome: 'yes' | 'no'; snapshot_at: Date | null }
  >(
    `SELECT panta_market_id, title, outcome, snapshot_at
       FROM pulse_markets
      WHERE session_id = $1 AND resolved = true AND outcome IS NOT NULL
      ORDER BY snapshot_at DESC NULLS LAST`,
    [sessionId],
  )
  return rows.map((row) => ({
    pulseMarketId: row.panta_market_id,
    title: row.title,
    outcome: row.outcome,
    resolvedAt: row.snapshot_at,
  }))
}
