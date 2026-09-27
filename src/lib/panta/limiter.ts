/**
 * In-process token buckets, one per Panta rate-limit family.
 *
 * Panta's limits are PER API KEY and SHARED BY EVERY PULSE USER. A single busy
 * room can exhaust the 20/min `build` budget for everyone. This is the one place
 * that meters them, which is a large part of why Pulse is a BFF rather than a
 * split frontend/backend (ARCHITECTURE.md §1).
 *
 * Three rules, all deliberate:
 *
 *   1. TOKEN BUCKET, NOT FIXED WINDOW. A fixed window lets a caller spend the
 *      whole quota in the last second of one window and again in the first
 *      second of the next, which is a 2x burst against a limit meant to be
 *      1x. Refill is continuous at capacity/60 per second.
 *
 *   2. FAIL OPEN. This limiter protects Panta. It must never be the reason
 *      Pulse is down. If the bucket logic itself throws, we allow the call and
 *      log it. A limiter that fails closed turns a Panta hiccup into a total
 *      outage.
 *
 *   3. Retry-After IS DELAY-SECONDS WITH JITTER. Returning an absolute timestamp
 *      makes every client retry at the same instant, manufacturing a
 *      thundering herd exactly when Panta is least able to absorb it.
 *
 * Sufficient for a single Vercel instance. If Pulse ever runs multi-instance,
 * this moves behind Redis — and that is the ONLY reason it would.
 */

import { PantaError, describePantaError } from './errors'

export type RateFamily = 'read' | 'positions' | 'quote' | 'build' | 'register' | 'upload'

/** Panta defaults: requests allowed per rolling 60s window, per API key. */
export const FAMILY_LIMITS: Record<RateFamily, number> = {
  read: 120,
  positions: 60,
  quote: 30,
  build: 20,
  register: 40,
  upload: 10,
}

const WINDOW_MS = 60_000

/**
 * Continuous-refill token bucket.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties: it reads the same and keeps the file runnable under Node's
 * strip-only type stripping, which is how `scripts/verify-resilience.ts`
 * exercises this module directly.
 */
class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private readonly capacity: number
  private readonly refillPerSecond: number

  constructor(capacity: number, refillPerSecond: number, nowMs: number) {
    this.capacity = capacity
    this.refillPerSecond = refillPerSecond
    this.tokens = capacity
    this.lastRefillMs = nowMs
  }

  private refill(nowMs: number): void {
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond)
    this.lastRefillMs = nowMs
  }

  /**
   * Attempt to spend one token.
   *
   * `conservative` inflates the reported wait for the tightest tier (`build`,
   * `upload`). The caller knows which tier a bucket belongs to; for the loosest
   * tier the exact wait is honest, because a blocked loose-tier caller will hit
   * the same empty bucket again on its next request and be told the same thing.
   */
  tryTake(nowMs: number = Date.now(), conservative = false): { ok: boolean; retryAfterSec: number } {
    this.refill(nowMs)
    if (this.tokens >= 1) {
      this.tokens -= 1
      return { ok: true, retryAfterSec: 0 }
    }
    const deficitTokens = 1 - this.tokens
    const waitMs = (deficitTokens / this.refillPerSecond) * 1000
    const seconds = Math.max(1, Math.ceil(waitMs / 1000))
    return { ok: false, retryAfterSec: conservative ? seconds * 2 : seconds }
  }

  /** Give a token back. Used when a multi-tier check fails after a token was
   *  already spent on a looser tier, so a refused call costs nothing. */
  refund(nowMs: number = Date.now()): void {
    this.refill(nowMs)
    this.tokens = Math.min(this.capacity, this.tokens + 1)
  }

  /** Read-only peek, for logging and tests. Does not spend. */
  peek(nowMs: number = Date.now()): number {
    this.refill(nowMs)
    return Math.floor(this.tokens)
  }

  /**
   * Adopt Panta's own view of our remaining budget.
   *
   * Only `remaining` is adopted. Panta's `X-RateLimit-Reset` is deliberately
   * IGNORED: it describes Panta's fixed window, while our bucket refills
   * continuously. Rewinding our refill clock to their window boundary would
   * hand out tokens Panta has already stopped accepting — the exact opposite of
   * the intent. The two models differ; we borrow the number, not the clock.
   */
  syncFromServer(remaining: number, nowMs: number = Date.now()): void {
    if (!Number.isFinite(remaining) || remaining < 0) return
    this.refill(nowMs)
    this.tokens = Math.min(this.tokens, remaining)
  }
}

/**
 * Family tier order. `build` is the tightest constraint in the entire product
 * (20/min shared), so a lenient tier must never be able to drain it.
 */
const FAMILY_TIER: Record<RateFamily, number> = {
  read: 0,
  positions: 0,
  quote: 1,
  build: 2,
  register: 1,
  upload: 2,
}

const familyBuckets = new Map<RateFamily, TokenBucket>()
let accountBucket: TokenBucket | null = null

function getFamilyBucket(family: RateFamily, nowMs: number): TokenBucket {
  let bucket = familyBuckets.get(family)
  if (!bucket) {
    const capacity = FAMILY_LIMITS[family]
    bucket = new TokenBucket(capacity, capacity / (WINDOW_MS / 1000), nowMs)
    familyBuckets.set(family, bucket)
  }
  return bucket
}

function getAccountBucket(nowMs: number): TokenBucket {
  if (!accountBucket) {
    // One shared ceiling across every family, so no single endpoint family can
    // consume the entire key budget on its own.
    const capacity = 200
    accountBucket = new TokenBucket(capacity, capacity / (WINDOW_MS / 1000), nowMs)
  }
  return accountBucket
}

/**
 * Jitter, so clients released by a shared limiter do not stampede Panta on the
 * same second. Full jitter is the safer variant: wait uniformly in [0, base].
 */
function withJitter(baseSec: number): number {
  return Math.ceil(baseSec * (0.5 + Math.random() * 0.5))
}

export interface AcquireResult {
  ok: boolean
  retryAfterSec: number
  family: RateFamily
}

/**
 * Spend one token from the family bucket and the account bucket.
 *
 * Never throws: on an internal fault it fails open and allows the call.
 */
export function acquire(family: RateFamily): AcquireResult {
  const nowMs = Date.now()
  try {
    // Tightest tier first.
    const tiers: Array<{ key: RateFamily | 'account'; tier: number }> = (
      [
        { key: 'account', tier: FAMILY_TIER[family] },
        { key: family, tier: FAMILY_TIER[family] },
      ] as Array<{ key: RateFamily | 'account'; tier: number }>
    ).sort((a, b) => b.tier - a.tier)

    for (const { key, tier } of tiers) {
      const bucket = key === 'account' ? getAccountBucket(nowMs) : getFamilyBucket(key, nowMs)
      // Higher tier number = tighter, so it should report the conservative wait.
      const result = bucket.tryTake(nowMs, tier >= 2)
      if (!result.ok) {
        // Refund anything already spent by looser tiers in this same attempt,
        // so a refused call costs the budget nothing.
        for (const earlier of tiers) {
          if (earlier.tier < tier) {
            const b =
              earlier.key === 'account'
                ? getAccountBucket(nowMs)
                : getFamilyBucket(earlier.key, nowMs)
            b.refund(nowMs)
          }
        }
        return { ok: false, retryAfterSec: withJitter(result.retryAfterSec), family }
      }
    }
    return { ok: true, retryAfterSec: 0, family }
  } catch (err) {
    // Fail open. Log loudly, allow the call, and let Panta be the authority.
    console.error('[panta/limiter] internal error, failing OPEN', err)
    return { ok: true, retryAfterSec: 0, family }
  }
}

/** Throw a 429-shaped PantaError if the bucket is empty. */
export function acquireOrThrow(family: RateFamily): void {
  const result = acquire(family)
  if (result.ok) return
  const shape = describePantaError('RATE_LIMITED', `local bucket ${family} exhausted`)
  throw new PantaError({ ...shape, retryAfterSec: result.retryAfterSec }, 429)
}

/**
 * Reconcile our bucket with Panta's headers after every response.
 *
 * Our local estimate is only as good as its clock and our traffic shape. Panta's
 * `X-RateLimit-Remaining` is authoritative, so we adopt it. Without this, two
 * serverless instances — or simply an unmodelled caller — drift apart and we
 * discover the drift as a 429 instead of pre-empting it.
 */
export function reconcileFromHeaders(headers: Headers, family: RateFamily): void {
  try {
    const remainingRaw = headers.get('X-RateLimit-Remaining')
    if (remainingRaw === null) return
    const remaining = Number(remainingRaw)
    if (!Number.isFinite(remaining)) return
    getFamilyBucket(family, Date.now()).syncFromServer(remaining)
  } catch (err) {
    console.warn('[panta/limiter] header reconcile failed, ignoring', err)
  }
}

/** Honour Panta's own Retry-After on a real 429, with jitter. */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get('Retry-After')
  if (raw === null) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return withJitter(Math.max(1, Math.ceil(n)))
}

/** Test seam. */
export function _resetLimiter(): void {
  familyBuckets.clear()
  accountBucket = null
}

/** Introspection for the ops endpoint / debugging. */
export function snapshot(): Record<string, { capacity: number; remaining: number }> {
  const nowMs = Date.now()
  const out: Record<string, { capacity: number; remaining: number }> = {}
  for (const family of Object.keys(FAMILY_LIMITS) as RateFamily[]) {
    out[family] = {
      capacity: FAMILY_LIMITS[family],
      remaining: getFamilyBucket(family, nowMs).peek(nowMs),
    }
  }
  out.account = { capacity: 200, remaining: getAccountBucket(nowMs).peek(nowMs) }
  return out
}
