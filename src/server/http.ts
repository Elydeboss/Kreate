import 'server-only'

/**
 * Route-level plumbing, so handlers stay about the product.
 *
 * Every API route does the same four things: read the wallet, parse a body,
 * map domain errors to status codes, and shape a response. Centralising the last
 * two is what stops a `MissingWalletError` from surfacing as a 500 in one route
 * and a 401 in another, which is the kind of inconsistency nobody notices until
 * a client is written against it.
 */

import { NextResponse } from 'next/server'
import { IdempotencyError, IDEMPOTENCY_HEADER } from './idempotency'
import { InvalidWalletError, MissingWalletError } from './identity'
import { PantaError } from '@/lib/panta/errors'

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init)
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/** The client's `Idempotency-Key`, or null. */
export function idempotencyKeyFrom(request: Request): string | null {
  return request.headers.get(IDEMPOTENCY_HEADER)
}

/**
 * Map a thrown error to a response.
 *
 * Order matters. `PantaError` and `IdempotencyError` both carry a status and
 * must be checked before the generic branch, or a Panta 429 becomes a 500 and the
 * client stops honouring `Retry-After`.
 *
 * ⚠ Only known error types are mapped. Anything unrecognised becomes a bare 500
 * with no detail, because an unexpected error's message is the one most likely
 * to contain something worth not sending. The detail goes to the log, always.
 */
export function handleRouteError(err: unknown, context: string): NextResponse {
  if (err instanceof PantaError) {
    // `userMessage`, not `message`. PantaError's own message is `${code}: ${detail}`,
    // where the detail can be an upstream diagnostic. The user-facing copy is
    // written in lib/panta/errors.ts and is what a person should read. See that
    // module for the ~30 codes and their retry/re-quote policy.
    const headers: Record<string, string> = {}
    if (typeof err.shape.retryAfterSec === 'number') {
      headers['Retry-After'] = String(Math.max(1, Math.ceil(err.shape.retryAfterSec)))
    }
    return NextResponse.json(
      { error: err.userMessage, code: err.code, retryable: err.retryable },
      { status: err.status, headers },
    )
  }

  if (err instanceof IdempotencyError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }

  if (err instanceof MissingWalletError) {
    return NextResponse.json({ error: err.message }, { status: 401 })
  }

  if (err instanceof InvalidWalletError) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }

  console.error(`[api/${context}] unhandled`, err)
  return NextResponse.json({ error: 'Something went wrong on our side.' }, { status: 500 })
}

/**
 * Read a JSON body, tolerating an empty one.
 *
 * Returns `{}` rather than throwing on an empty body, so a POST that genuinely
 * takes no arguments does not have to guard for it. Malformed JSON still throws,
 * because that is a client bug worth surfacing.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body is not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new BadRequestError('Expected a JSON object body.')
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/** Trimmed string field from a parsed body, or ''. */
export function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce a field to a finite number, or return null.
 *
 * Deliberately strict: `Number('')` is 0 and `Number(null)` is 0, both of which
 * would silently turn a missing amount into "spend nothing" or "buy zero".
 */
export function numField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}
