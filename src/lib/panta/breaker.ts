/**
 * Circuit breaker for the Panta API.
 *
 * Panta's Terms of Use §14 provides no SLA — the API is "as available" and
 * endpoints may be changed or discontinued. Panta WILL be slow or down. A
 * circuit breaker means that when it is, Pulse degrades predictably instead of
 * every request hanging until it times out and taking the Vercel function budget
 * with it.
 *
 * States:
 *   closed     — normal. Failures counted.
 *   open       — refusing calls fast. Stale cache is served instead.
 *   half-open  — one probe allowed through to test whether Panta recovered.
 *
 * While OPEN the UI must show a visible "prices as of HH:MM:SS" stamp. That is a
 * Panta ToU §5 compliance requirement, not a nicety: cached or stale data must
 * never be presented as live. See ARCHITECTURE.md §7.3 and the StalenessStamp
 * component.
 */

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerOptions {
  /** Consecutive failures before opening. */
  failureThreshold: number
  /** Consecutive successes in half-open before closing again. */
  successThreshold: number
  /** How long to stay open before probing. */
  resetTimeoutMs: number
  /** Rolling window over which failures are counted. */
  rollingWindowMs: number
}

export const DEFAULT_BREAKER: BreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 20_000,
  rollingWindowMs: 60_000,
}

interface BreakerState_ {
  state: BreakerState
  consecutiveFailures: number
  consecutiveSuccesses: number
  openedAtMs: number
  failureTimestamps: number[]
  /** True while a single half-open probe is out. Blocks concurrent probes. */
  probeInFlight: boolean
  lastError?: string
}

const breakers = new Map<string, BreakerState_>()

function getOrCreate(name: string): BreakerState_ {
  let b = breakers.get(name)
  if (!b) {
    b = {
      state: 'closed',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openedAtMs: 0,
      failureTimestamps: [],
      probeInFlight: false,
    }
    breakers.set(name, b)
  }
  return b
}

export interface BreakerPermit {
  allowed: boolean
  /** True when the call is a half-open probe. Only one may be in flight. */
  isProbe: boolean
  /** Populated when !allowed, so the UI can explain the degraded state. */
  state: BreakerState
  retryAfterSec?: number
}

/**
 * Ask permission to call. Call `recordSuccess` / `recordFailure` with the result,
 * or nothing happens and the breaker leaks toward open.
 */
export function acquirePermit(name: string, options: BreakerOptions = DEFAULT_BREAKER): BreakerPermit {
  const b = getOrCreate(name)
  const now = Date.now()

  if (b.state === 'open') {
    if (now - b.openedAtMs >= options.resetTimeoutMs) {
      b.state = 'half-open'
      b.consecutiveSuccesses = 0
      b.probeInFlight = true
      return { allowed: true, isProbe: true, state: 'half-open' }
    }
    const waited = options.resetTimeoutMs - (now - b.openedAtMs)
    return {
      allowed: false,
      isProbe: false,
      state: 'open',
      retryAfterSec: Math.max(1, Math.ceil(waited / 1000)),
    }
  }

  if (b.state === 'half-open') {
    // Exactly one probe at a time. A second concurrent caller is refused, which
    // is what stops half-open from turning into a thundering herd against a
    // service that just came back.
    if (b.probeInFlight) {
      return { allowed: false, isProbe: false, state: 'half-open', retryAfterSec: 1 }
    }
    b.probeInFlight = true
    return { allowed: true, isProbe: true, state: 'half-open' }
  }

  return { allowed: true, isProbe: false, state: 'closed' }
}

export function recordSuccess(name: string, wasProbe: boolean, options: BreakerOptions = DEFAULT_BREAKER): void {
  const b = getOrCreate(name)
  b.failureTimestamps = []
  b.lastError = undefined

  if (b.state === 'half-open' || wasProbe) {
    b.probeInFlight = false
    b.consecutiveSuccesses += 1
    if (b.consecutiveSuccesses >= options.successThreshold) {
      b.state = 'closed'
      b.consecutiveFailures = 0
      b.consecutiveSuccesses = 0
      b.openedAtMs = 0
      console.log(`[panta/breaker] CLOSED for "${name}". Service recovered.`)
    }
    return
  }

  b.consecutiveFailures = 0
}

export function recordFailure(
  name: string,
  error: string,
  wasProbe: boolean,
  options: BreakerOptions = DEFAULT_BREAKER,
): void {
  const b = getOrCreate(name)
  const now = Date.now()
  b.failureTimestamps = b.failureTimestamps.filter((t) => now - t < options.rollingWindowMs)
  b.failureTimestamps.push(now)
  b.lastError = error

  if (b.state === 'half-open' || wasProbe) {
    // The probe failed. Straight back to open with a fresh cool-off.
    b.probeInFlight = false
    b.state = 'open'
    b.openedAtMs = now
    b.consecutiveSuccesses = 0
    console.error(`[panta/breaker] probe failed for "${name}", re-opened.`)
    return
  }

  b.consecutiveFailures += 1
  if (b.consecutiveFailures >= options.failureThreshold) {
    b.state = 'open'
    b.openedAtMs = now
    b.consecutiveSuccesses = 0
    b.probeInFlight = false
    console.error(
      `[panta/breaker] OPEN for "${name}" after ${b.consecutiveFailures} consecutive failures. ` +
        `Serving stale cache with a staleness stamp until it recovers.`,
    )
  }
}

/** Current state, for the ops endpoint and for logging. */
export function breakerState(name: string): { state: BreakerState; lastError?: string; openSinceMs?: number } {
  const b = getOrCreate(name)
  return {
    state: b.state,
    lastError: b.lastError,
    openSinceMs: b.state === 'open' ? b.openedAtMs : undefined,
  }
}

export function isOpen(name: string): boolean {
  return getOrCreate(name).state === 'open'
}

/** Test seam. */
export function _resetBreakers(): void {
  breakers.clear()
}
