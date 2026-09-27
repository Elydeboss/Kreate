import 'server-only'

/**
 * Replay protection for BFF write routes.
 *
 * WHY. Mobile networks drop requests at exactly the moment a user is about to
 * tap again. Without replay protection, a double-tap — or a client that retries
 * because it never saw our response — creates two markets and charges two
 * creation fees. Panta is idempotent on `register`, `submit` and `trades`, but
 * Panta cannot help with the *quote* and *build* calls, and it cannot help with
 * our own writes. So we handle it here.
 *
 * THE ORDERING IS THE WHOLE POINT. The key is claimed BEFORE the handler runs.
 * Execute first and record after, and a crash in between leaves a completed side
 * effect with no key row — so the retry does it again, and for a market create
 * that is a second real fee. Claiming first means a crash leaves an in-progress
 * row, which `reapStaleKeys` reclaims.
 *
 * All SQL lives in lib/db/queries/idempotency.ts. This module is the protocol.
 */

import { createHash, randomUUID } from 'node:crypto'
import { claimKey, completeKey, findKey, releaseKey } from '@/lib/db/queries/idempotency'

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

/** The `Idempotency-Key` header name. */
export const IDEMPOTENCY_HEADER = 'idempotency-key'

/** A fresh key for a fresh user intent. The client mints this before it taps. */
export function newIdempotencyKey(): string {
  return randomUUID()
}

export interface IdempotentResult<T> {
  status: number
  response: T
  /** True when the stored response was replayed and the handler never ran. */
  replayed: boolean
}

/**
 * Claim, execute, and record.
 *
 *   same key + same body  -> replay the stored response, handler never runs
 *   same key + diff body  -> 409
 *   no key                 -> 400
 */
export async function withIdempotency<T>(
  key: string | null | undefined,
  route: string,
  body: unknown,
  handler: () => Promise<IdempotentRecord<T>>,
): Promise<IdempotentResult<T>> {
  if (!key) {
    throw new IdempotencyError('Idempotency-Key header is required on write routes', 400)
  }
  if (key.length < 8 || key.length > 200) {
    throw new IdempotencyError('Idempotency-Key must be 8-200 characters', 400)
  }

  const requestHash = hashRequest(body)

  const existing = await findKey(key)
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyError(
        'Idempotency-Key was already used for a different request body',
        409,
      )
    }
    if (existing.response !== null) {
      return { status: existing.status, response: existing.response as T, replayed: true }
    }
  }

  const won = await claimKey(key, route, requestHash)
  if (!won) {
    // A concurrent request with the same key is already running. Wait for its
    // result rather than executing the side effect a second time.
    return { ...(await waitForCompletion<T>(key, requestHash, route)), replayed: true }
  }

  try {
    const { status, response } = await handler()
    await completeKey(key, status, response)
    return { status, response, replayed: false }
  } catch (err) {
    // Release so a genuine retry can proceed. Leaving the key claimed would make
    // a transient Panta 5xx permanent for that user intent.
    await releaseKey(key).catch((cleanupErr) => console.error('[idempotency] release failed', cleanupErr))
    throw err
  }
}

/**
 * Poll for the winning request's result after losing an insert race.
 *
 * Bounded, because the winner is doing network work and will finish. On timeout
 * the caller is told to retry with the SAME key — which is safe precisely
 * because the claim is already in place, so a retry waits rather than re-executes.
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
    const row = await findKey(key)
    if (!row) continue
    if (row.requestHash !== requestHash) {
      throw new IdempotencyError(
        'Idempotency-Key was already used for a different request body',
        409,
      )
    }
    if (row.response !== null) {
      return { status: row.status, response: row.response as T }
    }
  }
  throw new IdempotencyError(
    `A concurrent request with this Idempotency-Key is still in flight on ${route}. ` +
      `Retry with the same key.`,
    409,
  )
}

export { reapStaleKeys } from '@/lib/db/queries/idempotency'
