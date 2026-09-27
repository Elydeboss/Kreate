/**
 * Panta error codes -> user-facing copy + retry policy.
 *
 * Two rules encoded here (AGENTS.md, "Conventions"):
 *   - Switch on Panta's `code`, never on HTTP status.
 *   - Never surface a raw Panta `message` to a user. Some are developer-facing
 *     and some leak internals. Every code gets hand-written copy.
 *
 * `retryable` means: safe for the client to try the same intent again after a
 * delay, with no user action. `reQuote` is narrower — it means the caller must
 * discard the current quote/order and fetch a fresh one, because the current
 * one is structurally dead (expired or stale), not merely rate-limited.
 */

import type { OrderSide } from './types'

export type PantaErrorKind =
  | 'expired' // createId / quoteId / orderId aged out — re-quote once
  | 'stale' // price moved past maxSlippageBps — re-quote once, tell the user
  | 'rejected' // the request will never succeed as-is — user must change input
  | 'duplicate' // market already exists for this creator+question
  | 'not_ready' // market is not in a state that allows this action
  | 'not_claimable' // win-claim preconditions not met
  | 'rate_limited' // Panta said no, or our token bucket said no
  | 'auth' // key missing, wrong, or lacks a capability
  | 'unsupported' // capability we deliberately do not implement
  | 'upstream' // Panta 5xx, timeout, or circuit open
  | 'network' // could not reach Panta at all
  | 'unknown'

export interface PantaErrorShape {
  /** Canonical machine code. `HTTP_xxx` for transport-level problems. */
  code: string
  kind: PantaErrorKind
  /** What the user is told. Never the raw Panta message. */
  userMessage: string
  /** Safe to retry the same intent automatically after a delay. */
  retryable: boolean
  /** Must fetch a fresh quote/order; the current one is dead. */
  reQuote: boolean
  /** Seconds to wait, when the caller should back off. */
  retryAfterSec?: number
  /** Log-only detail. Safe for your own logs, not for the UI. */
  detail?: string
}

const DEFINITIONS: Record<string, Omit<PantaErrorShape, 'code'>> = {
  // ── Expiry. Handled by re-quoting automatically, exactly once. ───────────
  CREATE_EXPIRED: {
    kind: 'expired',
    userMessage: 'That creation window closed. Starting a fresh one…',
    retryable: true,
    reQuote: true,
  },
  QUOTE_EXPIRED: {
    kind: 'expired',
    userMessage: 'The price moved while you were deciding. Refreshing…',
    retryable: true,
    reQuote: true,
  },
  ORDER_EXPIRED: {
    kind: 'expired',
    userMessage: 'That order expired before it was signed. Try again.',
    retryable: true,
    reQuote: true,
  },

  // ── Stale. The curve moved past the slippage bound. ──────────────────────
  QUOTE_STALE: {
    kind: 'stale',
    userMessage: 'The price moved. Review the new price and confirm again.',
    retryable: true,
    reQuote: true,
  },

  // ── Rejected. The user must change something. ────────────────────────────
  AMOUNT_TOO_SMALL: {
    kind: 'rejected',
    userMessage: 'That amount is below the minimum for this market.',
    retryable: false,
    reQuote: false,
  },
  AMOUNT_TOO_LARGE: {
    kind: 'rejected',
    userMessage: 'That amount is above the maximum for this market.',
    retryable: false,
    reQuote: false,
  },
  INSUFFICIENT_BALANCE: {
    kind: 'rejected',
    userMessage: 'Not enough USDC in this wallet.',
    retryable: false,
    reQuote: false,
  },
  INVALID_ADDRESS: {
    kind: 'rejected',
    userMessage: 'That wallet address is not valid.',
    retryable: false,
    reQuote: false,
  },
  MARKET_NOT_FOUND: {
    kind: 'rejected',
    userMessage: 'That market no longer exists.',
    retryable: false,
    reQuote: false,
  },
  VALIDATION_ERROR: {
    kind: 'rejected',
    userMessage: 'Some of those details are not valid. Check the form and retry.',
    retryable: false,
    reQuote: false,
  },

  // ── Duplicate. See ARCHITECTURE.md §4.3. ────────────────────────────────
  DUPLICATE_MARKET: {
    kind: 'duplicate',
    userMessage: 'You already have a market with that exact question open.',
    retryable: false,
    reQuote: false,
  },

  // ── State gates. ─────────────────────────────────────────────────────────
  MARKET_NOT_IN_PRIMARY: {
    kind: 'not_ready',
    userMessage: 'This market is not accepting positions right now.',
    retryable: false,
    reQuote: false,
  },
  MARKET_NOT_IN_SECONDARY: {
    kind: 'not_ready',
    userMessage: 'This market is not in its trading phase right now.',
    retryable: false,
    reQuote: false,
  },
  MARKET_NOT_ACTIVE: {
    kind: 'not_ready',
    userMessage: 'This market has closed.',
    retryable: false,
    reQuote: false,
  },
  MARKET_ALREADY_RESOLVED: {
    kind: 'not_ready',
    userMessage: 'This market is already resolved.',
    retryable: false,
    reQuote: false,
  },
  NOT_CLAIMABLE: {
    kind: 'not_claimable',
    userMessage: 'Nothing to claim on this one yet.',
    retryable: false,
    reQuote: false,
  },
  ALREADY_CLAIMED: {
    kind: 'not_claimable',
    userMessage: 'You have already claimed this.',
    retryable: false,
    reQuote: false,
  },

  // ── Deliberately unimplemented capability. Never ship a path to these. ───
  MARKET_NOT_GRADUATED: {
    kind: 'unsupported',
    userMessage: 'This market has not graduated, so fees do not apply yet.',
    retryable: false,
    reQuote: false,
  },
  NO_CREATOR_FEES: {
    kind: 'unsupported',
    userMessage: 'This market has no creator fees configured.',
    retryable: false,
    reQuote: false,
  },
  NOT_MARKET_CREATOR: {
    kind: 'unsupported',
    userMessage: 'Only the market creator can do that.',
    retryable: false,
    reQuote: false,
  },

  // ── Auth. ────────────────────────────────────────────────────────────────
  UNAUTHORIZED: {
    kind: 'auth',
    userMessage: 'Pulse lost its market connection. Try again shortly.',
    retryable: true,
    reQuote: false,
  },
  FORBIDDEN: {
    kind: 'auth',
    userMessage: 'This action is not available right now.',
    retryable: false,
    reQuote: false,
  },
  ACCOUNT_SUSPENDED: {
    kind: 'auth',
    userMessage: 'This action is temporarily unavailable.',
    retryable: true,
    reQuote: false,
  },

  // ── Transport. ──────────────────────────────────────────────────────────
  RATE_LIMITED: {
    kind: 'rate_limited',
    userMessage: 'Lots of activity right now. Give it a few seconds.',
    retryable: true,
    reQuote: false,
  },
  SERVICE_UNAVAILABLE: {
    kind: 'upstream',
    userMessage: 'The market service is having a moment. Prices may be delayed.',
    retryable: true,
    reQuote: false,
  },
  GATEWAY_TIMEOUT: {
    kind: 'upstream',
    userMessage: 'The market service is slow to respond. Try again.',
    retryable: true,
    reQuote: false,
  },
  INTERNAL_ERROR: {
    kind: 'upstream',
    userMessage: 'Something went wrong on the market service. Try again.',
    retryable: true,
    reQuote: false,
  },
  UPLOAD_NOT_CONFIGURED: {
    kind: 'unsupported',
    userMessage: 'Image uploads are unavailable. Pick a category tile instead.',
    retryable: false,
    reQuote: false,
  },
  TX_MISMATCH: {
    kind: 'rejected',
    userMessage: 'That transaction could not be matched to an order.',
    retryable: false,
    reQuote: false,
  },
  NETWORK_ERROR: {
    kind: 'network',
    userMessage: 'Could not reach the market service. Check your connection.',
    retryable: true,
    reQuote: false,
  },
  TIMEOUT: {
    kind: 'network',
    userMessage: 'The market service took too long to answer. Try again.',
    retryable: true,
    reQuote: false,
  },
}

const UNKNOWN: Omit<PantaErrorShape, 'code'> = {
  kind: 'unknown',
  userMessage: 'Something went wrong. Try again.',
  retryable: false,
  reQuote: false,
}

/** Build a normalised error shape from an arbitrary code. */
export function describePantaError(code: string, detail?: string): PantaErrorShape {
  const base = DEFINITIONS[code] ?? UNKNOWN
  return { code, ...base, detail }
}

/**
 * Error class for anything thrown by lib/panta/client.ts.
 *
 * Carries the normalised shape so route handlers can map it to an HTTP status
 * without re-deriving anything, and so the UI gets copy it can render directly.
 */
export class PantaError extends Error {
  readonly shape: PantaErrorShape
  readonly status: number

  constructor(shape: PantaErrorShape, status = 502) {
    super(`${shape.code}: ${shape.detail ?? shape.userMessage}`)
    this.name = 'PantaError'
    this.shape = shape
    this.status = status
  }

  get code(): string {
    return this.shape.code
  }

  get kind(): PantaErrorKind {
    return this.shape.kind
  }

  get userMessage(): string {
    return this.shape.userMessage
  }

  get retryable(): boolean {
    return this.shape.retryable
  }

  get reQuote(): boolean {
    return this.shape.reQuote
  }

  /** Client-visible payload. Deliberately excludes `detail`. */
  toJSON() {
    return {
      code: this.shape.code,
      kind: this.shape.kind,
      message: this.shape.userMessage,
      retryable: this.shape.retryable,
      reQuote: this.shape.reQuote,
      ...(this.shape.retryAfterSec !== undefined
        ? { retryAfterSec: this.shape.retryAfterSec }
        : {}),
    }
  }
}

/** Map a normalised error to the HTTP status the client should see. */
export function statusForError(shape: PantaErrorShape): number {
  switch (shape.kind) {
    case 'auth':
      return 502 // our key is broken, not the caller's fault
    case 'rate_limited':
      return 429
    case 'rejected':
    case 'duplicate':
    case 'not_ready':
    case 'not_claimable':
    case 'unsupported':
      return 400
    case 'expired':
    case 'stale':
      return 409
    case 'network':
      return 504
    default:
      return 502
  }
}

/**
 * Side-specific copy for a failed buy. Keeps the error component from having to
 * know which button the user pressed.
 */
export function buyErrorMessage(shape: PantaErrorShape, side: OrderSide): string {
  if (shape.code === 'MARKET_NOT_IN_PRIMARY') {
    return `This market is not accepting ${side.toUpperCase()} positions right now.`
  }
  if (shape.code === 'AMOUNT_TOO_SMALL') {
    return `Too small to take ${side.toUpperCase()} on this market.`
  }
  if (shape.code === 'QUOTE_STALE') {
    return `The ${side.toUpperCase()} price moved. Review it and confirm again.`
  }
  return shape.userMessage
}
