import 'server-only'

import { NextResponse } from 'next/server'

/**
 * Domain errors and their HTTP mapping, in one place.
 *
 * These classes used to be declared in `marketCreate.ts`, `marketBuy.ts` and
 * `marketClaim.ts`, each mapping itself to a status inside its own route. That
 * produced the exact inconsistency `http.ts` exists to prevent: the same class of
 * "the user asked for something impossible" error came back as a 400 from one
 * route and a 500 from the next, depending on which flow raised it and whether
 * the route remembered to check.
 *
 * The rule they share: a validation error is always the CALLER's fault, so it is
 * always a 4xx with copy a person can act on. Anything that is genuinely our
 * fault stays an exception and becomes a 500 in `handleRouteError`, where it is
 * logged and findable. The line between the two is worth stating precisely,
 * because blurring it is how a real bug gets reported to a user as "invalid
 * input" and never gets fixed.
 *
 *   CALLER FAULT (4xx)                    OUR FAULT (5xx)
 *   ─────────────────────                  ──────────────────
 *   the market is closed                   a market we created has no session
 *   the amount is below the minimum        Panta returned a shape we cannot read
 *   the category is not in the allowlist   the ledger disagrees with Panta
 *   the order is not yours to submit
 */

/** Something about the request cannot be satisfied. 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * A market cannot be traded, for a state reason rather than a bad field.
 *
 * 409 rather than 400: the request was perfectly well-formed, the market is
 * simply in the wrong state for it. The distinction matters to the client, which
 * disables the buy button on a 409 and shows a validation message on a 400.
 */
export class ConflictError extends Error {
  readonly code: string
  constructor(message: string, code = 'CONFLICT') {
    super(message)
    this.name = 'ConflictError'
    this.code = code
  }
}

/** We were asked to act on something we do not have a record of. 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/**
 * Map a domain error to a response, or return null if it is not one.
 *
 * Returning null rather than throwing lets a route write:
 *
 *   const domain = domainErrorResponse(err)
 *   if (domain) return domain
 *   return handleRouteError(err, 'markets/quote')
 *
 * which keeps the domain cases visible at the top of the handler, next to the
 * other early returns, instead of buried in a catch block after a generic one.
 */
export function domainErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, code: 'INVALID' }, { status: 400 })
  }

  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
  }

  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message, code: 'NOT_FOUND' }, { status: 404 })
  }

  return null
}
