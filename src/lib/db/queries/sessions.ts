import { db, isPgError, PG_UNIQUE_VIOLATION, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'
import { toNum } from './values'

/**
 * Live sessions. One per circle at a time, in practice.
 *
 * `ends_at` is the load-bearing column: it is the single source for every market
 * in the session's `end_time`, so all markets close together and the scoreboard
 * has a boundary. Deriving it per market instead would let one market outlive
 * the watch party it belongs to.
 */

export type SessionStatus = 'active' | 'ended'

export interface SessionRow extends QueryResultRow {
  id: string
  circle_id: string
  title: string
  stream_url: string | null
  status: SessionStatus
  started_at: Date
  ends_at: Date
  ended_at: Date | null
}

export interface LiveSession {
  id: string
  circleId: string
  title: string
  streamUrl: string | null
  status: SessionStatus
  startedAt: Date
  endsAt: Date
  endedAt: Date | null
}

/** Default session length when the creator does not pick one. */
export const DEFAULT_DURATION_MINUTES = 120

function toSession(row: SessionRow): LiveSession {
  return {
    id: row.id,
    circleId: row.circle_id,
    title: row.title,
    streamUrl: row.stream_url,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    endedAt: row.ended_at,
  }
}

export class ActiveSessionExistsError extends Error {
  constructor() {
    super('This circle already has a live session. End it before starting another.')
    this.name = 'ActiveSessionExistsError'
  }
}

/**
 * Start a session.
 *
 * Refuses if the circle already has an active one. Two concurrent watch parties
 * in one circle would make `ends_at` ambiguous, and every market in the room
 * would inherit the wrong deadline.
 *
 * The partial unique index on `live_sessions (circle_id) WHERE status = 'active'`
 * is what actually makes this race-proof. The explicit check below only exists to
 * turn a 23505 into a message a person can read; a caller that skipped it would
 * still be stopped by the index.
 */
export async function startSession(
  input: {
    circleId: string
    title: string
    streamUrl?: string | null
    endsAt?: Date
    durationMinutes?: number
  },
  executor: Db = db,
): Promise<LiveSession> {
  const endsAt =
    input.endsAt ??
    new Date(Date.now() + (input.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000)

  const existing = await executor.queryOne<{ id: string }>(
    `SELECT id FROM live_sessions WHERE circle_id = $1 AND status = 'active' LIMIT 1`,
    [input.circleId],
  )
  if (existing) throw new ActiveSessionExistsError()

  try {
    const row = await executor.queryOne<SessionRow>(
      `INSERT INTO live_sessions (circle_id, title, stream_url, started_at, ends_at, status)
       VALUES ($1, $2, $3, now(), GREATEST($4::timestamptz, now() + interval '1 minute'), 'active')
       RETURNING id, circle_id, title, stream_url, status, started_at, ends_at, ended_at`,
      [input.circleId, input.title.trim(), input.streamUrl ?? null, endsAt.toISOString()],
    )
    if (!row) throw new Error('session insert returned no row')
    return toSession(row)
  } catch (err) {
    // Lost the race against a concurrent start. The index did its job; report it
    // the same way as the pre-check rather than as a 500.
    if (isPgError(err, PG_UNIQUE_VIOLATION)) throw new ActiveSessionExistsError()
    throw err
  }
}

export async function findSessionById(id: string, executor: Db = db): Promise<LiveSession | null> {
  const row = await executor.queryOne<SessionRow>(
    `SELECT id, circle_id, title, stream_url, status, started_at, ends_at, ended_at
       FROM live_sessions
      WHERE id = $1`,
    [id],
  )
  return row ? toSession(row) : null
}

/** The circle's active session, or null. */
export async function findActiveSession(
  circleId: string,
  executor: Db = db,
): Promise<LiveSession | null> {
  const row = await executor.queryOne<SessionRow>(
    `SELECT id, circle_id, title, stream_url, status, started_at, ends_at, ended_at
       FROM live_sessions
      WHERE circle_id = $1 AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1`,
    [circleId],
  )
  return row ? toSession(row) : null
}

/**
 * Find the active session by id, treating an expired one as still active.
 *
 * `status` is flipped to 'ended' by a lazy sweep, not by a cron — a session past
 * `ends_at` is over whether or not anyone has marked it. Refusing to serve a
 * room because the sweep has not run yet would strand people mid-watch-party.
 */
export async function findLiveSession(id: string, executor: Db = db): Promise<LiveSession | null> {
  const row = await executor.queryOne<SessionRow>(
    `SELECT id, circle_id, title, stream_url, status, started_at, ends_at, ended_at
       FROM live_sessions
      WHERE id = $1 AND status = 'active' AND ends_at > now()`,
    [id],
  )
  return row ? toSession(row) : null
}

export async function listSessionsForCircle(
  circleId: string,
  limit = 20,
  executor: Db = db,
): Promise<LiveSession[]> {
  const rows = await executor.query<SessionRow>(
    `SELECT id, circle_id, title, stream_url, status, started_at, ends_at, ended_at
       FROM live_sessions
      WHERE circle_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [circleId, Math.min(Math.max(limit, 1), 100)],
  )
  return rows.map(toSession)
}

/**
 * End a session.
 *
 * Idempotent. Ending an already-ended session returns the same row rather than
 * failing, because the client that ends it is a button and the thing that also
 * ends it is the expiry sweep — and both will eventually fire.
 */
export async function endSession(id: string, executor: Db = db): Promise<LiveSession | null> {
  const row = await executor.queryOne<SessionRow>(
    `UPDATE live_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, now())
      WHERE id = $1
      RETURNING id, circle_id, title, stream_url, status, started_at, ends_at, ended_at`,
    [id],
  )
  return row ? toSession(row) : null
}

/**
 * Flip sessions past their `ends_at` to 'ended'.
 *
 * Run opportunistically from a request rather than on a cron. It is idempotent
 * and cheap, and an over-16-day deadline is not the moment to introduce a
 * scheduler that needs its own uptime story.
 */
export async function sweepExpiredSessions(executor: Db = db): Promise<number> {
  const result = await executor.query<{ id: string }>(
    `UPDATE live_sessions
        SET status = 'ended', ended_at = ends_at
      WHERE status = 'active' AND ends_at <= now()
      RETURNING id`,
  )
  return result.length
}

/** Seconds remaining in the session, floored at zero. Drives the room countdown. */
export async function secondsRemaining(id: string, executor: Db = db): Promise<number | null> {
  const row = await executor.queryOne<{ remaining: string }>(
    `SELECT GREATEST(EXTRACT(EPOCH FROM (ends_at - now())), 0)::text AS remaining
       FROM live_sessions
      WHERE id = $1`,
    [id],
  )
  return row ? toNum(row.remaining) : null
}
