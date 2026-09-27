import 'server-only'

/**
 * The Panta client. The ONLY module in the codebase that knows the Panta base
 * URL or holds the API key.
 *
 * Every call made here is automatically: rate-metered, cached, circuit-broken,
 * retried with jitter, header-reconciled, logged with a request id, and
 * normalised into a typed error. A route handler cannot accidentally bypass any
 * of that, because there is no other way to reach Panta. See AGENTS.md rule 2.
 *
 * Non-negotiables encoded here:
 *   - Trailing slash on every path. Panta 404s without it.
 *   - The key is injected here and never leaves the server.
 *   - Retries only where Panta is documented idempotent, and only within a
 *     retry budget. Unbounded retries amplify load during an incident.
 *   - Cached reads return `asOf` and `stale` so the UI can satisfy ToU §5.
 */

import { PANTA_API_KEY, PANTA_BASE_URL } from '@/lib/server/env'
import { PantaError, describePantaError } from './errors'
import { acquirePermit, isOpen, recordFailure, recordSuccess } from './breaker'
import { acquire, reconcileFromHeaders, retryAfterFromHeaders, type RateFamily } from './limiter'
import {
  cached,
  passthrough,
  peekStale,
  type CacheOptions,
  type CacheResult,
  type CacheSource,
} from './cache'

const USER_AGENT = 'Pulse/0.1 (+colosseum-worlds-fair)'

/**
 * One breaker for the whole Panta surface, not one per route family.
 *
 * Deliberate. Panta is a single upstream with no SLA (ToU §14): when it returns
 * 5xx, it does so across the board. Per-route breakers would let a dead market
 * detail endpoint leave the quote and build paths calling a service that is
 * already failing, and would multiply the state we have to reason about for no
 * benefit at this scale.
 */
const BREAKER_NAME = 'panta'

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_ATTEMPTS = 3

/**
 * Retry budget. Netflix measured 2-4x load amplification from uncoordinated
 * retries. We cap retries as a fraction of total attempts: once retries exceed
 * 30% of all requests, we stop retrying and surface the error instead. Under
 * normal operation this never binds; during an incident it stops us from being
 * the reason the incident is prolonged.
 */
const RETRY_BUDGET_RATIO = 0.3
let totalRequests = 0
let totalRetries = 0

export interface PantaRequestOptions {
  /** Rate-limit family. Decides which token bucket is spent. */
  family: RateFamily
  /**
   * Cache settings. Omit to always go upstream (correct for quotes and builds,
   * which mint short-lived session ids).
   */
  cache?: CacheOptions & { key: string }
  /**
   * Safe to retry the identical request. True for Panta's documented-idempotent
   * routes and for all GETs. False for anything that mints a new session id.
   */
  idempotent?: boolean
  /**
   * Panta attribution id, sent as X-User-Id. Required on primary quote and
   * build for /account/metrics/ to separate Pulse users.
   */
  userId?: string
  timeoutMs?: number
  /** Free-form label used in logs only. Never contains secrets. */
  label?: string
}

export interface PantaResponse<T> extends CacheResult<T> {
  /** Panta's X-Request-Id, or ours if Panta did not send one. */
  requestId: string
}

// ── URL ─────────────────────────────────────────────────────────────────────

/**
 * Panta requires a trailing slash on every route. Normalise defensively so a
 * missing slash is fixed rather than becoming a confusing 404.
 */
function buildUrl(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  const withTrailing = withLeading.endsWith('/') ? withLeading : `${withLeading}/`
  return `${PANTA_BASE_URL}${withTrailing}`
}

// ── Transport ───────────────────────────────────────────────────────────────

interface AttemptOutcome {
  ok: boolean
  data?: unknown
  requestId: string
  error?: PantaError
  /** Wall-clock duration of this attempt, for the log line. */
  ms: number
  /** Delay the caller should wait before the next attempt, in ms. */
  retryAfterMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exponential backoff with full jitter. The jitter matters: without it, every
 * caller released by a 429 retries on the same schedule and we manufacture a
 * thundering herd against a service that is already struggling.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(200 * 2 ** (attempt - 1), 4000)
  return Math.floor(Math.random() * base)
}

function retryBudgetAvailable(): boolean {
  const total = totalRequests + totalRetries
  if (total === 0) return true
  return totalRetries / total < RETRY_BUDGET_RATIO
}

async function attempt<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  opts: PantaRequestOptions,
  requestId: string,
): Promise<AttemptOutcome> {
  // 1. Circuit breaker. Refused fast, so a dead upstream does not consume the
  //    function timeout budget on every request.
  const permit = acquirePermit(BREAKER_NAME)
  if (!permit.allowed) {
    return {
      ok: false,
      requestId,
      ms: 0,
      error: new PantaError(
        {
          ...describePantaError('SERVICE_UNAVAILABLE', `circuit open for ${path}`),
          retryAfterSec: permit.retryAfterSec,
        },
        503,
      ),
      retryAfterMs: (permit.retryAfterSec ?? 5) * 1000,
    }
  }

  // 2. Local token bucket. Never throws — fails open by design.
  const permitToken = acquire(opts.family)
  if (!permitToken.ok) {
    // Not an upstream failure. Do not punish the breaker for our own limiting.
    return {
      ok: false,
      requestId,
      ms: 0,
      error: new PantaError(
        {
          ...describePantaError('RATE_LIMITED', `local ${opts.family} bucket exhausted`),
          retryAfterSec: permitToken.retryAfterSec,
        },
        429,
      ),
      retryAfterMs: permitToken.retryAfterSec * 1000,
    }
  }

  // 3. The actual call. Our own AbortController for the upstream request — this
  //    is NOT a caller's signal. See cache.ts trap 2: a coalesced request has no
  //    single owner to cancel on, so client.ts owns the timeout itself.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const res = await fetch(buildUrl(path), {
      method,
      headers: {
        'X-Api-Key': PANTA_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Request-Id': requestId,
        ...(opts.userId ? { 'X-User-Id': opts.userId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    })

    // 4. Adopt Panta's view of our budget. Our local estimate drifts; theirs
    //    is authoritative. This is what stops us discovering the drift as a 429.
    reconcileFromHeaders(res.headers, opts.family)

    const pantaRequestId = res.headers.get('X-Request-Id') ?? requestId

    if (res.ok) {
      recordSuccess(BREAKER_NAME, permit.isProbe)
      const data = (await res.json()) as T
      return { ok: true, data, requestId: pantaRequestId, ms: Date.now() - startedAt }
    }

    // 5. Error response. Switch on Panta's `code`, never on the HTTP status.
    const text = await res.text()
    let parsed: { code?: string; message?: string; detail?: string } = {}
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : {}
    } catch {
      parsed = { message: text.slice(0, 200) }
    }

    const code = parsed.code ?? httpFallbackCode(res.status)
    const detail = `${parsed.message ?? ''} ${parsed.detail ?? ''}`.trim() || res.statusText
    const shape = describePantaError(code, detail)

    // Rate limited: honour Panta's Retry-After (already jittered) over our own.
    const serverRetryAfterSec = retryAfterFromHeaders(res.headers)

    // 5xx and transport problems are the breaker's business. 4xx are our fault
    //    or the caller's, and must not open the circuit.
    if (res.status >= 500) {
      recordFailure(BREAKER_NAME, `${code} ${detail}`, permit.isProbe)
    }

    return {
      ok: false,
      requestId: pantaRequestId,
      ms: Date.now() - startedAt,
      error: new PantaError(
        { ...shape, ...(serverRetryAfterSec ? { retryAfterSec: serverRetryAfterSec } : {}) },
        res.status,
      ),
      retryAfterMs: serverRetryAfterSec ? serverRetryAfterSec * 1000 : undefined,
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    const detail = isTimeout ? `timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : String(err)
    recordFailure(BREAKER_NAME, detail, permit.isProbe)
    const shape = describePantaError(isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR', detail)
    return {
      ok: false,
      requestId,
      ms: Date.now() - startedAt,
      error: new PantaError(shape, 504),
      retryAfterMs: backoffMs(1),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function httpFallbackCode(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'MARKET_NOT_FOUND'
    case 409:
      return 'QUOTE_STALE'
    case 422:
      return 'VALIDATION_ERROR'
    case 429:
      return 'RATE_LIMITED'
    case 502:
    case 503:
      return 'SERVICE_UNAVAILABLE'
    case 504:
      return 'GATEWAY_TIMEOUT'
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN'
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────

async function execute<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  opts: PantaRequestOptions,
): Promise<PantaResponse<T>> {
  totalRequests += 1
  const requestId = crypto.randomUUID()
  const maxAttempts = opts.idempotent === false ? 1 : MAX_ATTEMPTS

  let lastError: PantaError | undefined
  let lastRetryAfterMs: number | undefined
  let lastMs = 0
  let lastStatus = 0

  for (let n = 1; n <= maxAttempts; n += 1) {
    const isLast = n === maxAttempts
    const outcome = await attempt<T>(method, path, body, opts, requestId)

    lastMs = outcome.ms
    lastStatus = outcome.error?.status ?? 200

    if (outcome.ok) {
      logCall({
        method,
        path,
        status: 200,
        ms: outcome.ms,
        requestId: outcome.requestId,
        label: opts.label,
        outcome: 'ok',
        attempt: n,
      })
      return {
        value: outcome.data as T,
        asOf: Date.now(),
        stale: false,
        source: 'loaded' as CacheSource,
        requestId: outcome.requestId,
      }
    }

    // Narrow through a local so TS is not re-reading a `let` it cannot prove.
    const failure = outcome.error
    if (!failure) break
    lastError = failure
    lastRetryAfterMs = outcome.retryAfterMs

    const canRetry = !isLast && failure.retryable && opts.idempotent !== false && retryBudgetAvailable()

    if (!canRetry) break

    totalRetries += 1
    // Prefer the server's instruction, else exponential backoff with jitter.
    const wait = lastRetryAfterMs ?? backoffMs(n)
    await sleep(wait)
  }

  const finalError = lastError
  logCall({
    method,
    path,
    status: lastStatus,
    ms: lastMs,
    requestId,
    label: opts.label,
    outcome: lastStatus >= 500 || lastStatus === 0 ? 'network' : 'error',
    code: finalError?.code,
  })

  throw finalError ?? new PantaError(describePantaError('UNKNOWN', 'no outcome recorded'), 502)
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * GET a Panta route. Cached when `opts.cache` is supplied.
 *
 * When the circuit breaker is open, a cached value inside its staleness ceiling
 * is served with `stale: true` and `degraded` set, rather than surfacing an
 * error. That is the behaviour described in ARCHITECTURE.md §7.3 — and because
 * the result carries `stale: true`, the route propagates it and the UI is
 * obliged to show the "prices as of HH:MM:SS" stamp (Panta ToU §5).
 */
export function pantaGet<T>(path: string, opts: PantaRequestOptions): Promise<PantaResponse<T>> {
  const cacheOpts = opts.cache
  if (!cacheOpts) {
    return execute<T>('GET', path, undefined, { ...opts, idempotent: true })
  }
  const { key, ...rest } = cacheOpts

  if (isOpen(BREAKER_NAME)) {
    const stale = peekStale<T>(key)
    if (stale) {
      logCall({
        method: 'GET',
        path,
        status: 0,
        ms: 0,
        requestId: 'breaker-open',
        label: opts.label,
        outcome: 'degraded',
        code: 'SERVE_STALE',
      })
      return Promise.resolve({
        value: stale.value,
        asOf: stale.asOf,
        stale: true,
        source: 'stale' as CacheSource,
        requestId: 'breaker-open',
        degraded: 'Panta unreachable — serving last known value',
      })
    }
  }

  return cachedGet<T>(key, rest, path, opts)
}

/**
 * Read through the cache, then flatten the cached wrapper into a single
 * `PantaResponse`.
 *
 * The cache tracks *when we fetched* (`asOf`); the wrapped response carries the
 * data and the request id. The cache's timestamp is the authoritative one for the
 * staleness stamp, because it is when Panta actually answered.
 */
async function cachedGet<T>(
  key: string,
  cacheOpts: CacheOptions,
  path: string,
  opts: PantaRequestOptions,
): Promise<PantaResponse<T>> {
  const res = await cached<PantaResponse<T>>(key, cacheOpts, () =>
    execute<T>('GET', path, undefined, { ...opts, idempotent: true }),
  )
  return {
    value: res.value.value,
    asOf: res.asOf,
    stale: res.stale,
    source: res.source,
    requestId: res.value.requestId,
    ...(res.degraded ? { degraded: res.degraded } : {}),
  }
}

/** POST to a Panta route. Never cached — these mint short-lived session ids. */
export function pantaPost<T>(
  path: string,
  body: unknown,
  opts: PantaRequestOptions,
): Promise<PantaResponse<T>> {
  return execute<T>('POST', path, body, opts)
}

/**
 * GET with coalescing but no storage. For reads that must be current but are
 * still worth folding when several requests land at once.
 */
export function pantaGetShared<T>(path: string, opts: PantaRequestOptions): Promise<PantaResponse<T>> {
  const key = opts.cache?.key ?? `shared:${path}`
  return passthrough<PantaResponse<T>>(key, () =>
    execute<T>('GET', path, undefined, { ...opts, idempotent: true }),
  ).then((res) => ({
    value: res.value.value,
    asOf: res.asOf,
    stale: res.stale,
    source: res.source,
    requestId: res.value.requestId,
  }))
}

// ── Typed route helpers ─────────────────────────────────────────────────────
// Thin wrappers that pin the rate family and idempotency of each documented
// route, so a call site cannot get the policy wrong. See ARCHITECTURE.md §3.1.

export const panta = {
  account: () => pantaGet<import('./types').PantaAccount>('account/', { family: 'read' }),

  metrics: () =>
    pantaGet<import('./types').PantaAccountMetrics>('account/metrics/', {
      family: 'read',
      cache: { key: 'metrics', ttlMs: 60_000, staleMs: 120_000 },
    }),

  accountTrades: () => pantaGet<import('./types').PantaAccountTrade[]>('account/trades/', { family: 'read' }),

  accountCreates: () => pantaGet<import('./types').PantaAccountCreate[]>('account/creates/', { family: 'read' }),

  categories: () =>
    pantaGet<unknown>('categories/', {
      family: 'read',
      // The category allowlist is effectively static. Long TTL.
      cache: { key: 'categories', ttlMs: 600_000, staleMs: 600_000 },
    }),

  /** The ONLY live-price source. markets/list returns null prices. */
  /**
   * The only live-price source. `markets/list` does NOT carry live prices, so a
   * room needs one call per market — which is why `ttlMs` is overridable.
   *
   * The default is a safety net for callers with no budget context. Anything
   * running inside a room passes the TTL derived from its own market count in
   * server/priceSync.ts, so a 20-market room slows down instead of spending a
   * rate limit it does not have.
   */
  market: (marketId: string, ttlMs?: number) =>
    pantaGet<import('./types').PantaMarketDetail>(`markets/${marketId}/`, {
      family: 'read',
      cache: {
        key: `market:${marketId}`,
        ttlMs: ttlMs ?? 20_000,
        staleMs: (ttlMs ?? 20_000) * 2,
      },
      label: 'market-detail',
    }),

  /** Real on-chain tape. Never synthesise a substitute for this. */
  marketTrades: (marketId: string, ttlMs?: number) =>
    pantaGet<import('./types').PantaTrade[]>(`markets/${marketId}/trades/`, {
      family: 'read',
      cache: {
        key: `trades:${marketId}`,
        ttlMs: ttlMs ?? 15_000,
        staleMs: (ttlMs ?? 15_000) * 2,
      },
      label: 'trade-tape',
    }),

  walletTrades: (wallet: string) =>
    pantaGet<import('./types').PantaTrade[]>(`wallets/${wallet}/trades/`, {
      family: 'read',
      cache: { key: `wtrades:${wallet}`, ttlMs: 30_000, staleMs: 60_000 },
    }),

  /** Wallet-scoped and share-denominated. Do not persist. */
  positions: (wallet: string) =>
    pantaGet<import('./types').PantaPosition[]>('positions/', {
      family: 'positions',
      cache: { key: `positions:${wallet}`, ttlMs: 30_000, staleMs: 30_000 },
      label: 'positions',
    }),

  // ── Create market. TTLs: createId ~5min, blockhash ~60s. ─────────────────
  createQuote: (body: import('./types').CreateQuoteRequest) =>
    pantaPost<import('./types').CreateQuoteResponse>('markets/create/quote/', body, {
      family: 'quote',
      // Not idempotent: each call mints a new createId.
      idempotent: false,
      userId: body.userId,
      label: 'create-quote',
    }),

  createBuild: (body: import('./types').CreateBuildRequest) =>
    pantaPost<import('./types').CreateBuildResponse>('markets/create/build/', body, {
      family: 'build',
      idempotent: false,
      userId: body.userId,
      label: 'create-build',
    }),

  /** Idempotent on (createId, signature). Retry freely. */
  register: (body: import('./types').RegisterRequest) =>
    pantaPost<import('./types').RegisterResponse>('markets/register/', body, {
      family: 'register',
      idempotent: true,
      label: 'create-register',
    }),

  // ── Primary order. TTLs: quoteId ~90s, orderId ~120s, blockhash ~60s. ────
  primaryOrderQuote: (body: import('./types').OrderQuoteRequest) =>
    pantaPost<import('./types').OrderQuoteResponse>('primaryorderquote/', body, {
      family: 'quote',
      idempotent: false,
      userId: body.userId,
      label: 'order-quote',
    }),

  /**
   * ⚠ Takes a QUOTE ID. The orderId is minted HERE and comes back in the
   * response. The two are easy to swap — the response carries the orderId and
   * the request does not — and a swap is a 400 with no useful message.
   */
  primaryOrderBuild: (body: import('./types').OrderBuildRequest) =>
    pantaPost<import('./types').OrderBuildResponse>('primaryorderbuild/', body, {
      family: 'build',
      idempotent: false,
      userId: body.userId,
      label: 'order-build',
    }),

  /** Idempotent on (orderId, signature). Retry freely. */
  primaryOrderSubmit: (body: import('./types').OrderSubmitRequest) =>
    pantaPost<import('./types').OrderSubmitResponse>('primaryordersubmit/', body, {
      family: 'register',
      idempotent: true,
      label: 'order-submit',
    }),

  /** Omit the signature to ask "is this order still good?" before one exists. */
  primaryOrderVerify: (body: import('./types').OrderVerifyRequest) =>
    pantaPost<import('./types').OrderVerifyResponse>('primaryorderverify/', body, {
      family: 'read',
      idempotent: true,
      label: 'order-verify',
    }),

  // ── Claim. TRANSACTION SHAPE B, same as buy. ────────────────────────────
  /**
   * There is no claim SUBMIT step. The claim is finished the moment the
   * transaction confirms; `/trades/` afterwards is a receipt to Panta, not a
   * submission. Forgetting this is a common way to leave a claim half-reported.
   */
  claimBuild: (wallet: string, marketId: string) =>
    pantaPost<import('./types').ClaimBuildResponse>('claim/build/', { wallet, marketId }, {
      family: 'build',
      idempotent: false,
      label: 'claim-build',
    }),

  /** Attribution. Idempotent on signature. buy and claim only — never a
   *  creator-fee claim, which Panta rejects with TX_MISMATCH by design. */
  reportTrade: (body: import('./types').ReportTradeRequest) =>
    pantaPost<import('./types').ReportTradeResponse>('trades/', body, {
      family: 'register',
      idempotent: true,
      userId: body.userId,
      label: 'report-trade',
    }),
} as const

// ── Logging ─────────────────────────────────────────────────────────────────

interface LogFields {
  method: string
  path: string
  status: number
  ms: number
  requestId: string
  label?: string
  outcome: 'ok' | 'error' | 'network' | 'degraded'
  code?: string
  attempt?: number
}

/**
 * Structured single-line log per call. The request id is the join key between
 * Pulse's logs and Panta's, so paste it into a support request if one is needed.
 * Never logs the key, the request body, or the RPC URL.
 */
function logCall(f: LogFields): void {
  const parts = [
    `panta ${f.method}`,
    f.path,
    f.outcome === 'degraded' ? 'STALE' : `${f.status}`,
    `${f.ms}ms`,
    `req=${f.requestId}`,
    f.label ? `label=${f.label}` : null,
    f.code ? `code=${f.code}` : null,
    f.attempt && f.attempt > 1 ? `attempt=${f.attempt}` : null,
  ].filter(Boolean)
  const line = parts.join(' ')

  if (f.outcome === 'ok') console.log(line)
  else if (f.outcome === 'degraded') console.warn(line)
  else console.error(line)
}

export { PantaError, statusForError } from './errors'
export { invalidate, invalidatePrefix, invalidateAll, stats as cacheStats, cacheKeys, onRefreshFailure } from './cache'
export { snapshot as limiterSnapshot } from './limiter'
export { breakerState } from './breaker'
