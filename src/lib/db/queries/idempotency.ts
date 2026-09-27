import { db, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'

/**
 * Replay protection for BFF write routes.
 *
 * The protocol these rows implement:
 *
 *   same key + same request hash -> replay the stored response, do not re-execute
 *   same key + different hash    -> 409, the client reused a key for a new intent
 *   no key                       -> 400, writes require one
 *
 * The ordering is the whole point. The key row is claimed BEFORE the side effect
 * runs. Executing first and recording after would mean a crash in between leaves
 * a completed side effect with no key row, and the retry does it a second time —
 * which for a market create is a second real fee. Claiming first means a crash
 * leaves an in-progress row at status 0, which `reapStaleKeys` reclaims.
 *
 * See src/server/idempotency.ts for the protocol wrapper.
 */

export interface KeyRow extends QueryResultRow {
  key: string
  route: string
  request_hash: string
  status: number
  response: unknown
  created_at: Date
}

export interface ExistingKey {
  requestHash: string
  status: number
  /** Null while in flight. Non-null means the work finished. */
  response: unknown
}

export async function findKey(key: string, executor: Db = db): Promise<ExistingKey | null> {
  const row = await executor.queryOne<KeyRow>(
    `SELECT request_hash, status, response FROM idempotency_keys WHERE key = $1`,
    [key],
  )
  if (!row) return null
  return { requestHash: row.request_hash, status: row.status, response: row.response }
}

/**
 * Claim a key. Returns true if we won, false if someone else already holds it.
 *
 * A false return is not an error — it means a concurrent request with the same key
 * is already running, and the caller should wait for it rather than execute.
 */
export async function claimKey(
  key: string,
  route: string,
  requestHash: string,
  executor: Db = db,
): Promise<boolean> {
  const rows = await executor.query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, route, request_hash, status, response)
     VALUES ($1, $2, $3, 0, NULL)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, route, requestHash],
  )
  return rows.length > 0
}

export async function completeKey(
  key: string,
  status: number,
  response: unknown,
  executor: Db = db,
): Promise<void> {
  await executor.query(
    `UPDATE idempotency_keys
        SET status = $2, response = $3::jsonb
      WHERE key = $1`,
    [key, status, JSON.stringify(response ?? null)],
  )
}

/**
 * Release a claimed key after the handler threw.
 *
 * Only releases rows that never got a response, so a completed run is never
 * undone by a late cleanup. Without this, one transient Panta 5xx would make that
 * user's intent permanently impossible to retry.
 */
export async function releaseKey(key: string, executor: Db = db): Promise<void> {
  await executor.query(`DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL`, [key])
}

/**
 * Reap keys that were claimed and never completed.
 *
 * Only a crash between claim and complete produces these. Schedule on Vercel
 * Cron — daily is plenty. Without it the table grows without bound and, worse,
 * nobody notices that a route is dying mid-write.
 */
export async function reapStaleKeys(
  olderThanMinutes = 60,
  executor: Db = db,
): Promise<number> {
  const rows = await executor.query<{ key: string }>(
    `DELETE FROM idempotency_keys
      WHERE response IS NULL
        AND created_at < now() - make_interval(mins => $1)
      RETURNING key`,
    [olderThanMinutes],
  )
  return rows.length
}

/**
 * Count keys stuck in flight. For the ops page — a non-zero value sustained over
 * time means a write path is throwing before it completes.
 */
export async function countStaleKeys(executor: Db = db): Promise<number> {
  const row = await executor.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM idempotency_keys WHERE response IS NULL`,
  )
  return row ? Number(row.count) : 0
}
