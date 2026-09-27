import 'server-only'

/**
 * Idempotency for BFF write routes.
 *
 * WHY. Mobile networks drop requests in the exact place where a user is about to
 * tap again. Without replay protection, a double-tap — or a client that retries
 * because it never saw our response — creates two markets and charges two
 * creation fees. Panta is idempotent on `register`, `submit` and `trades`, but
 * Panta cannot help with the *quote* and *build* calls, and it cannot help with
 * our own writes. So we handle it here.
 *
 * THE CONTRACT:
 *   same key + same request hash -> replay the stored response, do not re-execute
 *   same key + different hash    -> 409, the client reused a key for a new intent
 *   no key                       -> reject, writes require one
 *
 * THE ORDERING MATTERS. The key row is inserted BEFORE the side effect, inside a
 * transaction. If we executed first and recorded after, a crash in between would
 * leave a completed side effect with no key, and the retry would do it again.
 * Inserting first means a crash leaves an in-progress row, which the reaper
 * below reclaims.
 */

import { createHash, randomUUID } from 'node:crypto'
import { query, queryOne } from '@/lib/db'

export class IdempotencyError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'IdempotencyError'
    this.status = status
  }
}

export interface IdempotentRecord<T> {
  status: number
  response: T
}

/** Stable hash of a request body. Key order must not affect the result. */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

type Outcome<T> =
  | { kind: 'replay'; record: IdempotentRecord<T> }
  | { kind: 'conflict' }
  | { kind: 'execute' }

/**
 * Claim, execute, and record — the one function routes should use.
 *
 *   same key + same body  -> replay the stored response, handler never runs
 *   same key + diff body  -> 409
 *   no key                 -> 400
 *
 * The key is claimed BEFORE the handler runs, so a crash cannot leave a
 * completed side effect unrecorded. If the handler throws, the key is released
 * so a genuine retry can proceed — otherwise a transient Panta failure would be
 * permanent for that user intent.
 */
export async function withIdempotency<T>(
  key: string | null | undefined,
  route: string,
  body: unknown,
  handler: () => Promise<{ status: number; response: T }>,
): Promise<{ status: number; response: T; replayed: boolean }> {
  if (!key) {
    throw new IdempotencyError('Idempotency-Key header is required on write routes', 400)
  }
  if (key.length < 8 || key.length > 200) {
    throw new IdempotencyError('Idempotency-Key must be 8-200 characters', 400)
  }

  const requestHash = hashRequest(body)

  const existing = await queryOne<{ request_hash: string; status: number; response: unknown }>(
    'SELECT request_hash, status, response FROM idempotency_keys WHERE key = $1',
    [key],
  )

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyError(
        'Idempotency-Key was already used for a different request body',
        409,
      )
    }
    if (existing.response !== null) {
      return { status: existing.status, response: existing.response as T, replayed: true }
    }
  }

  // Claim before executing. RETURNING tells us whether we won the race.
  const claimed = await query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, route, request_hash, status, response)
     VALUES ($1, $2, $3, 0, NULL)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, route, requestHash],
  )

  if (claimed.length === 0) {
    // Lost the race to a concurrent request with the same key. Wait for its
    // result rather than executing the side effect a second time.
    const raced = await waitForCompletion<T>(key, requestHash, route)
    return { ...raced, replayed: true }
  }

  try {
    const { status, response } = await handler()
    await query('UPDATE idempotency_keys SET status = $2, response = $3 WHERE key = $1', [
      key,
      status,
      JSON.stringify(response ?? null),
    ])
    return { status, response, replayed: false }
  } catch (err) {
    // Release the key so a genuine retry can proceed. Leaving it claimed would
    // make a transient upstream failure permanent for this intent.
    await query('DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL', [key]).catch(
      (cleanupErr) => console.error('[idempotency] failed to release key', cleanupErr),
    )
    throw err
  }
}

/**
 * Poll for the winning request's result after losing an insert race.
 * Bounded, because the winner is doing network work and will finish.
 */
async function waitForCompletion<T>(
  key: string,
  requestHash: string,
  route: string,
  attempts = 20,
  intervalMs = 250,
): Promise<IdempotentRecord<T>> {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    const row = await queryOne<{ request_hash: string; status: number; response: unknown }>(
      'SELECT request_hash, status, response FROM idempotency_keys WHERE key = $1',
      [key],
    )
    if (!row) continue
    if (row.request_hash !== requestHash) {
      throw new IdempotencyError(
        'Idempotency-Key was already used for a different request body',
        409,
      )
    }
    if (row.response !== null) {
      return { status: row.status, response: row.response as T }
    }
  }
  // The winner is still working. Tell the caller to retry with the SAME key.
  throw new IdempotencyError(
    `A concurrent request with this Idempotency-Key is still in flight on ${route}. ` +
      `Retry with the same key.`,
    409,
  )
}

/** Fresh key for a fresh user intent. */
export function newIdempotencyKey(): string {
  return randomUUID()
}

/**
 * Reap in-progress keys older than `olderThanMinutes`.
 *
 * Schedule this on Vercel Cron (daily is fine). Without it, a crash during a
 * write leaves rows at status 0 forever and the table grows without bound.
 */
export async function reapStaleKeys(olderThanMinutes = 60): Promise<number> {
  const rows = await query<{ key: string }>(
    `DELETE FROM idempotency_keys
      WHERE response IS NULL
        AND created_at < now() - ($1 || ' minutes')::interval
      RETURNING key`,
    [String(olderThanMinutes)],
  )
  return rows.length
}
