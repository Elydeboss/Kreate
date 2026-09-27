'use client'

/**
 * The browser's view of Pulse's own API.
 *
 * Two things every write does, both easy to forget at a call site:
 *
 *  1. Attaches the connected wallet, so the server can resolve who is asking.
 *     See server/identity.ts for what that header does and does not prove.
 *  2. Carries an `Idempotency-Key` that is stable across retries of ONE user
 *     intent and different across different intents.
 *
 * (2) is the subtle one. The key must be generated once per intent, outside the
 * retry loop — minting a fresh one on every attempt defeats replay protection
 * entirely, and that is exactly the case it exists for: a mobile client that
 * never saw the response and taps again.
 */

import { clientConfig } from './config'

export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  /** True when the same call might succeed later. False means fix the request. */
  readonly retryable: boolean

  constructor(message: string, status: number, code: string | null, retryable: boolean) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/** Mint a key for one user intent. Call once, then reuse it for every retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      payload = {}
    }
  }

  if (!response.ok) {
    throw new ApiError(
      typeof payload.error === 'string' ? payload.error : `Request failed (${response.status})`,
      response.status,
      typeof payload.code === 'string' ? payload.code : null,
      // 4xx fails identically on retry, so retrying spends the user's time and
      // our rate budget to produce the same answer. 408 and 429 are the
      // exceptions: both are explicitly "try again".
      response.status >= 500 || response.status === 408 || response.status === 429,
    )
  }

  return payload as T
}

function networkError(err: unknown): Error {
  // A fetch rejection is a network failure, never a 4xx. Saying so lets the
  // caller offer a retry instead of showing "that code does not exist". An abort
  // is the caller's own doing and must pass through unchanged, or a cancelled
  // request surfaces as a connection error the user cannot act on.
  if ((err as Error)?.name === 'AbortError') {
    return err instanceof Error ? err : new ApiError('Request cancelled', 0, 'ABORTED', false)
  }
  return new ApiError('Could not reach Pulse. Check your connection.', 0, 'NETWORK', true)
}

/**
 * GET a Pulse endpoint.
 *
 * `cache: 'no-store'` throughout: every read here is either a live price or a
 * membership check, and a cached circle list is a real bug — a user who was
 * removed from a circle would keep seeing it.
 */
export async function apiGet<T>(path: string, wallet: string, signal?: AbortSignal): Promise<T> {
  try {
    const response = await fetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Pulse-Wallet': wallet },
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
    return await parseResponse<T>(response)
  } catch (err) {
    throw networkError(err)
  }
}

/** POST a JSON body with replay protection. */
export async function apiPost<T>(
  path: string,
  wallet: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Pulse-Wallet': wallet,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return await parseResponse<T>(response)
  } catch (err) {
    throw networkError(err)
  }
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export interface Circle {
  id: string
  code: string
  name: string
  createdBy: string
  createdAt: string
}

export function listCircles(wallet: string, signal?: AbortSignal) {
  return apiGet<{ circles: Circle[] }>('/api/circles', wallet, signal)
}

export function createCircle(wallet: string, name: string, idempotencyKey: string) {
  return apiPost<{ circle: Circle }>('/api/circles', wallet, { name }, idempotencyKey)
}

export function joinCircle(wallet: string, code: string, idempotencyKey: string) {
  return apiPost<{ circle: Circle; joined: boolean }>(
    '/api/circles/join',
    wallet,
    { code },
    idempotencyKey,
  )
}

export { clientConfig }
