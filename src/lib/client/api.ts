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
import type { CreateQuoteRequest, OrderSide, PantaInstruction } from '@/lib/panta/types'

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

// ── Market creation ──────────────────────────────────────────────────────────

/**
 * The three steps of a create, and the type asymmetry between them.
 *
 * Step 2 is TRANSACTION SHAPE A — a pre-assembled base64 blob. Steps 1 and 3 are
 * plain JSON. The type names say which is which, because a caller that treats
 * this response as an instruction list compiles, typechecks, and then fails in
 * the wallet with a message about a missing field.
 */
export interface CreateQuote {
  pulseMarketId: string
  createId: string
  /** Panta's quoted fee, base units, as a decimal string for display. */
  paymentUsdc: string
  duplicateOf?: string
}

export interface CreateBuild {
  createId: string
  /** SHAPE A. Base64 VersionedTransaction, unsigned, with a blockhash inside. */
  transaction: string
  recentBlockhash: string
  lastValidBlockHeight: number | null
  paymentUsdc: string
  expiresAt: string | null
}

/** Note: no idempotency key is required, and none is accepted. */
export function quoteMarket(wallet: string, body: CreateQuoteRequest, idempotencyKey: string) {
  return apiPost<CreateQuote>('/api/markets/quote', wallet, body, idempotencyKey)
}

export function buildMarket(wallet: string, createId: string, idempotencyKey: string) {
  return apiPost<CreateBuild>('/api/markets/build', wallet, { createId }, idempotencyKey)
}

export function registerMarket(
  wallet: string,
  createId: string,
  signature: string,
  idempotencyKey: string,
) {
  return apiPost<{ pulseMarketId: string; pantaMarketId: string; status: string }>(
    '/api/markets/register',
    wallet,
    { createId, signature },
    idempotencyKey,
  )
}

// ── Buying ───────────────────────────────────────────────────────────────────

export interface BuyQuote {
  pulseMarketId: string
  quoteId: string
  shares: string
  /** A decimal string. Not a number — see OrderQuoteResponse. */
  avgPrice: string
  feeUsdc: string
  expiresAt: string
}

export interface BuyBuild {
  orderId: string
  quoteId: string
  /** SHAPE B. Raw instructions; the client compiles the message. */
  instructions: PantaInstruction[]
  recentBlockhash: string
  lastValidBlockHeight: number | null
  expectedShares: string
  amountUsdc: string
  side: OrderSide
  /** True when the quote went stale and we re-quoted. Show the new price. */
  requoted: boolean
  avgPrice?: string
  feeUsdc?: string
}

/** No idempotency key: a quote writes nothing. See the route for why. */
export function quoteBuy(
  wallet: string,
  body: { circleId: string; pulseMarketId: string; side: OrderSide; amountUsdc: string; maxSlippageBps?: number },
) {
  return apiGetOrPost<BuyQuote>('/api/orders/quote', wallet, body)
}

export function buildBuy(
  wallet: string,
  body: {
    circleId: string
    pulseMarketId: string
    quoteId: string
    side: OrderSide
    amountUsdc: string
    maxSlippageBps?: number
  },
  idempotencyKey: string,
) {
  return apiPost<BuyBuild>('/api/orders/build', wallet, body, idempotencyKey)
}

export function submitBuy(
  wallet: string,
  orderId: string,
  signature: string,
  idempotencyKey: string,
) {
  return apiPost<{ orderId: string; status: string; attributed: boolean }>(
    '/api/orders/submit',
    wallet,
    { orderId, signature },
    idempotencyKey,
  )
}

/** Tell the server an order was never signed. Safe to call twice, and on failure. */
export function abandonOrder(wallet: string, orderId: string) {
  return apiDelete('/api/orders/submit', wallet, { orderId })
}

// ── Claims ───────────────────────────────────────────────────────────────────

export interface ClaimablePosition {
  pulseMarketId: string
  pantaMarketId: string
  marketTitle: string
  side: OrderSide
  shares: string
  expectedPayoutUsdc: string
  outcome: 'yes' | 'no'
}

export function listClaims(wallet: string, circleId: string, signal?: AbortSignal) {
  return apiGet<{ circleId: string; claims: ClaimablePosition[] }>(
    `/api/claims?circleId=${encodeURIComponent(circleId)}`,
    wallet,
    signal,
  )
}

export interface ClaimBuild {
  pulseMarketId: string
  /** SHAPE B, same module as a buy. */
  instructions: PantaInstruction[]
  recentBlockhash: string
  lastValidBlockHeight: number | null
  outcome: 'yes' | 'no'
  winningShares: string
  payoutUsdc: string
}

export function buildClaim(wallet: string, circleId: string, pulseMarketId: string, idempotencyKey: string) {
  return apiPost<ClaimBuild>('/api/claims/build', wallet, { circleId, pulseMarketId }, idempotencyKey)
}

export function receiptClaim(
  wallet: string,
  pulseMarketId: string,
  signature: string,
  payoutUsdc: string,
  idempotencyKey: string,
) {
  return apiPost<{ attributed: boolean }>(
    '/api/claims/receipt',
    wallet,
    { pulseMarketId, signature, payoutUsdc },
    idempotencyKey,
  )
}

/**
 * A POST that needs no replay protection.
 *
 * Exists for exactly one caller: quoting a buy. The key would be a header the
 * server ignores, and a caller who has to invent one for a read-only call will
 * eventually reuse a key across two genuinely different buys — which is the one
 * case where a wrong key does real harm. Refusing to take one is safer than
 * accepting one and ignoring it.
 */
async function apiGetOrPost<T>(
  path: string,
  wallet: string,
  body: unknown,
): Promise<T> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Pulse-Wallet': wallet,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return await parseResponse<T>(response)
  } catch (err) {
    throw networkError(err)
  }
}

/** DELETE with a JSON body, for abandoning something locally. */
async function apiDelete<T>(path: string, wallet: string, body: unknown): Promise<T> {
  try {
    const response = await fetch(path, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Pulse-Wallet': wallet,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return await parseResponse<T>(response)
  } catch (err) {
    // An abandoned order is a local cleanup. If the call fails there is nothing
    // actionable for the user — the money was never spent and the order will be
    // reaped — so a failure is swallowed rather than surfaced.
    return undefined as T
  }
}

export { clientConfig }
