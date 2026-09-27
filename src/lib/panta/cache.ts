/**
 * TTL cache with single-flight coalescing and stale-while-revalidate.
 *
 * WHY THIS EXISTS. GET /markets/{id}/ is the only live-price endpoint, and it
 * costs one request per market against a 120/min budget SHARED BY EVERY PULSE
 * USER. A six-market room refreshing every 5s is 72 requests/min for one person.
 * So clients poll our own origin (free), the server serves from this cache, and
 * concurrent misses fold into a single upstream call.
 *
 * This is a large part of why Pulse is a BFF: coalescing needs one process.
 *
 * ── The three traps, all of which are real incidents in the wild ────────────
 *
 * 1. DELETE FROM `inflight` IN `finally`, NOT `then`. In a `.then()` the delete
 *    only runs on fulfilment, so a rejected promise stays in the map and is
 *    handed to every future caller for that key — a cached failure that never
 *    expires and never retries.
 *
 * 2. NEVER PASS A CALLER'S AbortSignal INTO THE SHARED REQUEST. The first
 *    component to unmount would abort the fetch for every other caller still
 *    waiting on it. Coalescing means shared ownership of the request; there is
 *    no single caller to cancel for.
 *
 * 3. THE CACHE KEY IS A SECURITY BOUNDARY. Put the user-scoped dimension
 *    FIRST — `positions:{wallet}`, `market:{marketId}`. Coalescing positions on
 *    the path alone would serve one user's positions to another. The client
 *    never chooses these keys directly; the route layer that owns the user
 *    dimension builds them.
 *
 * ── Staleness is a compliance requirement, not a performance one ───────────
 *
 * Panta ToU §5 forbids presenting cached or stale data as live Panta data. So
 * every result carries `asOf`, routes propagate it as `prices_as_of`, and the
 * UI renders a StalenessStamp whenever `stale` is true. A hard staleness ceiling
 * bounds how long we will serve a stale value, and refresh failures raise an
 * alarm rather than silently continuing — otherwise a failing origin is masked
 * by quietly serving old data, which is the exact failure ToU §5 is about.
 */

export interface CacheOptions {
  /** How long a value is served without any refresh attempt. */
  ttlMs: number
  /**
   * How long past `ttlMs` a stale value may still be served while a background
   * refresh runs. Beyond this the next read blocks on a fresh load.
   */
  staleMs?: number
  /** Set false to bypass the cache entirely (used by admin/ops routes). */
  enabled?: boolean
}

export type CacheSource = 'fresh' | 'stale' | 'loaded'

export interface CacheResult<T> {
  value: T
  /** When the value was fetched from Panta. Drives the staleness stamp. */
  asOf: number
  /** True when the value is past its TTL. Requires a visible stamp in the UI. */
  stale: boolean
  source: CacheSource
  /** Populated when the breaker refused and we served stale anyway. */
  degraded?: string
}

interface Entry<T> {
  value: T
  storedAtMs: number
  freshUntilMs: number
  staleUntilMs: number
  refreshing: boolean
}

const store = new Map<string, Entry<unknown>>()

/**
 * In-flight foreground loads, keyed by cache key. This is the single-flight map.
 * See trap 1 above.
 */
const inflight = new Map<string, Promise<CacheResult<unknown>>>()

// ── Alarms ──────────────────────────────────────────────────────────────────

export interface RefreshFailureAlarm {
  key: string
  error: string
  consecutiveFailures: number
  lastSuccessAtMs: number | null
  servingStaleSinceMs: number | null
}

type AlarmListener = (alarm: RefreshFailureAlarm) => void
const alarmListeners = new Set<AlarmListener>()
const failureCounts = new Map<string, { count: number; lastSuccessAtMs: number | null }>()

/**
 * Subscribe to background-refresh failures. Wire this to whatever alerting you
 * have. Without a listener, refresh failures are only visible in logs, and a
 * silently-stale price display is a ToU §5 problem.
 */
export function onRefreshFailure(fn: AlarmListener): () => void {
  alarmListeners.add(fn)
  return () => alarmListeners.delete(fn)
}

function raiseRefreshFailure(key: string, error: string, servingStaleSinceMs: number | null): void {
  const record = failureCounts.get(key) ?? { count: 0, lastSuccessAtMs: null }
  record.count += 1
  failureCounts.set(key, record)
  const alarm: RefreshFailureAlarm = {
    key,
    error,
    consecutiveFailures: record.count,
    lastSuccessAtMs: record.lastSuccessAtMs,
    servingStaleSinceMs,
  }
  for (const listener of alarmListeners) {
    try {
      listener(alarm)
    } catch (err) {
      console.error('[panta/cache] alarm listener threw', err)
    }
  }
}

function noteRefreshSuccess(key: string): void {
  failureCounts.set(key, { count: 0, lastSuccessAtMs: Date.now() })
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Read through the cache, coalescing concurrent misses into one upstream call.
 */
export async function cached<T>(
  key: string,
  options: CacheOptions,
  loader: () => Promise<T>,
): Promise<CacheResult<T>> {
  if (options.enabled === false) {
    const value = await loader()
    return { value, asOf: Date.now(), stale: false, source: 'loaded' }
  }

  const now = Date.now()
  const entry = store.get(key) as Entry<T> | undefined

  if (entry) {
    if (now < entry.freshUntilMs) {
      return { value: entry.value, asOf: entry.storedAtMs, stale: false, source: 'fresh' }
    }
    if (now < entry.staleUntilMs) {
      // Stale-while-revalidate: answer immediately, refresh out of band.
      triggerBackgroundRefresh(key, options, loader, entry.storedAtMs)
      return { value: entry.value, asOf: entry.storedAtMs, stale: true, source: 'stale' }
    }
    // Past the hard staleness ceiling. Fall through and block on fresh data.
  }

  return singleFlight(key, options, loader)
}

/** Load with no caching at all, but still share one call across callers. */
export async function passthrough<T>(key: string, loader: () => Promise<T>): Promise<CacheResult<T>> {
  return singleFlight(key, { ttlMs: 0, staleMs: 0, enabled: false }, loader)
}

function singleFlight<T>(
  key: string,
  options: CacheOptions,
  loader: () => Promise<T>,
): Promise<CacheResult<T>> {
  const existing = inflight.get(key) as Promise<CacheResult<T>> | undefined
  if (existing) return existing

  // trap 2: `loader` here must not close over any caller's AbortSignal.
  const promise = (async () => {
    const value = await loader()
    const now = Date.now()
    if (options.enabled !== false && options.ttlMs > 0) {
      const staleMs = options.staleMs ?? options.ttlMs * 3
      store.set(key, {
        value,
        storedAtMs: now,
        freshUntilMs: now + options.ttlMs,
        staleUntilMs: now + options.ttlMs + staleMs,
        refreshing: false,
      })
      noteRefreshSuccess(key)
    }
    return { value, asOf: now, stale: false, source: 'loaded' as CacheSource }
  })()

  const tracked = promise as Promise<CacheResult<unknown>>
  inflight.set(key, tracked)

  // trap 1: `finally`, not `then`. A rejected promise must not linger in the map
  // as a cached failure served to every future caller.
  void tracked.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key)
  }).catch(() => {
    // The rejection is delivered to whoever awaits `promise`. This catch exists
    // only to stop the finally-chain from becoming an unhandled rejection.
  })

  return promise
}

function triggerBackgroundRefresh<T>(
  key: string,
  options: CacheOptions,
  loader: () => Promise<T>,
  staleSinceMs: number,
): void {
  const entry = store.get(key) as Entry<T> | undefined
  if (!entry || entry.refreshing) return
  // Fold a background refresh into an in-flight foreground load if one exists,
  // so we never have two concurrent upstream calls for the same key.
  if (inflight.has(key)) return

  entry.refreshing = true
  void (async () => {
    try {
      const value = await loader()
      const now = Date.now()
      const staleMs = options.staleMs ?? options.ttlMs * 3
      store.set(key, {
        value,
        storedAtMs: now,
        freshUntilMs: now + options.ttlMs,
        staleUntilMs: now + options.ttlMs + staleMs,
        refreshing: false,
      })
      noteRefreshSuccess(key)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[panta/cache] background refresh failed for "${key}": ${message}`)
      // Leave the old entry in place. It is still servable until the hard
      // staleness ceiling, and it carries `asOf` so the UI can stamp it.
      if (entry.refreshing) entry.refreshing = false
      raiseRefreshFailure(key, message, staleSinceMs)
    }
  })()
}

// ── Invalidation ────────────────────────────────────────────────────────────

/** Drop one key. */
export function invalidate(key: string): void {
  store.delete(key)
  failureCounts.delete(key)
}

/**
 * Drop every key starting with `prefix`.
 *
 * Called after a confirmed trade: the price moved, so every cached read of that
 * market — detail, tape, and any position valuation derived from it — is now
 * wrong. Failing to invalidate here means a user buys YES at 0.52 and the UI
 * still shows 0.48 for the next 20 seconds.
 */
export function invalidatePrefix(prefix: string): number {
  let removed = 0
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key)
      failureCounts.delete(key)
      removed += 1
    }
  }
  return removed
}

/** Drop everything. Ops use, and the rehearsal cold path. */
export function invalidateAll(): void {
  store.clear()
  failureCounts.clear()
}

/**
 * Read a value without triggering any load, or return null.
 *
 * Used by the circuit-breaker path: when Panta is down we want to serve the
 * last known value with a visible staleness stamp rather than show an error.
 * Returns a result only if a value exists AND is still inside its hard
 * staleness ceiling — past that, serving it would be indefensible under ToU §5.
 */
export function peekStale<T>(key: string, nowMs: number = Date.now()): CacheResult<T> | null {
  const entry = store.get(key) as Entry<T> | undefined
  if (!entry) return null
  if (nowMs >= entry.staleUntilMs) return null
  return {
    value: entry.value,
    asOf: entry.storedAtMs,
    stale: true,
    source: 'stale',
  }
}

// ── Introspection ───────────────────────────────────────────────────────────

export interface CacheStats {
  keys: number
  fresh: number
  stale: number
  inflight: number
  oldestStoredAtMs: number | null
}

export function stats(): CacheStats {
  const now = Date.now()
  let fresh = 0
  let stale = 0
  let oldest: number | null = null
  for (const entry of store.values()) {
    if (now < entry.freshUntilMs) fresh += 1
    else if (now < entry.staleUntilMs) stale += 1
    if (oldest === null || entry.storedAtMs < oldest) oldest = entry.storedAtMs
  }
  return { keys: store.size, fresh, stale, inflight: inflight.size, oldestStoredAtMs: oldest }
}

/** Test seam. */
export function _resetCache(): void {
  store.clear()
  inflight.clear()
  failureCounts.clear()
}

/**
 * Canonical cache key builders.
 *
 * Centralised so the user-scoped-first rule (trap 3) is applied in exactly one
 * place and cannot be forgotten at a call site.
 */
export const cacheKeys = {
  market: (marketId: string) => `market:${marketId}`,
  marketTrades: (marketId: string) => `trades:${marketId}`,
  walletTrades: (wallet: string) => `wtrades:${wallet}`,
  positions: (wallet: string) => `positions:${wallet}`,
  categories: () => 'categories',
  account: () => 'account',
  metrics: () => 'metrics',
  /** Prefix matching every cached read that depends on this market's price. */
  marketPrefix: (marketId: string) => `market:${marketId}`,
  tradesPrefix: (marketId: string) => `trades:${marketId}`,
} as const
