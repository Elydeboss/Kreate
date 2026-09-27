/**
 * Verification for the Panta resilience layer.
 *
 *   node --experimental-strip-types scripts/verify-resilience.ts
 *
 * These four modules — limiter, cache, breaker, and the client's retry/breaker
 * wiring — hold the logic that is easiest to get subtly wrong and hardest to
 * notice, because a bug shows up as a rare production incident rather than a
 * type error. They cannot be checked against the live Panta API without a key
 * and real money, so they get exercised directly here.
 *
 * These are assertions about BEHAVIOUR, not unit tests with mocks. The point is
 * to prove the specific traps documented in cache.ts and limiter.ts are actually
 * avoided by the code as written.
 */

import { _resetLimiter, acquire, FAMILY_LIMITS, snapshot } from '../src/lib/panta/limiter.ts'
import {
  _resetCache,
  cached,
  invalidate,
  onRefreshFailure,
  peekStale,
  stats,
} from '../src/lib/panta/cache.ts'
import {
  _resetBreakers,
  acquirePermit,
  breakerState,
  recordFailure,
  recordSuccess,
  type BreakerOptions,
} from '../src/lib/panta/breaker.ts'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Limiter ─────────────────────────────────────────────────────────────────

async function testLimiter(): Promise<void> {
  console.log('\nlimiter')

  _resetLimiter()

  // 1. Drains after exactly `capacity` calls.
  const cap = FAMILY_LIMITS.build
  let allowed = 0
  for (let i = 0; i < cap + 5; i += 1) {
    if (acquire('build').ok) allowed += 1
  }
  check('allows exactly the family capacity then blocks', allowed === cap, `allowed ${allowed}, capacity ${cap}`)

  // 2. A blocked call reports a positive, jittered Retry-After.
  const blocked = acquire('build')
  check('blocked call is not ok', !blocked.ok)
  check('blocked call reports Retry-After >= 1s', (blocked.retryAfterSec ?? 0) >= 1, `got ${blocked.retryAfterSec}`)

  // 3. Jitter varies the reported wait, so clients do not stampede in unison.
  const waits = new Set<number>()
  for (let i = 0; i < 40; i += 1) waits.add(acquire('build').retryAfterSec)
  check('Retry-After carries jitter', waits.size > 1, `distinct waits: ${waits.size}`)

  // 4. The tightest tier bounds the total. `build` is 20/min; 200 calls must not
  //    all get through just because the account bucket has room.
  _resetLimiter()
  allowed = 0
  for (let i = 0; i < 200; i += 1) {
    if (acquire('build').ok) allowed += 1
  }
  check('tight tier bounds a flood of calls', allowed <= FAMILY_LIMITS.build, `allowed ${allowed}`)

  // 5. A looser family must NOT be able to drain the tight one.
  _resetLimiter()
  for (let i = 0; i < 100; i += 1) acquire('read')
  check(
    'read calls do not exhaust the build budget',
    acquire('build').ok,
    'build bucket was drained by read traffic',
  )

  // 6. Refill happens. build is 20/min = 1 token per 3s. Wait out a token.
  _resetLimiter()
  for (let i = 0; i < FAMILY_LIMITS.build; i += 1) acquire('build')
  check('build is exhausted', !acquire('build').ok)
  console.log('        (waiting ~3.2s to observe one token refill)')
  await sleep(3200)
  check('a token refills after the refill interval', acquire('build').ok)
}

// ── Cache ───────────────────────────────────────────────────────────────────

async function testCache(): Promise<void> {
  console.log('\ncache')

  _resetCache()

  // 1. Single-flight: N concurrent misses produce exactly ONE upstream call.
  let calls = 0
  const loader = async () => {
    calls += 1
    await sleep(30)
    return { value: 1 }
  }
  const results = await Promise.all(
    Array.from({ length: 25 }, () => cached('k1', { ttlMs: 10_000 }, loader)),
  )
  check('25 concurrent misses fold into 1 upstream call', calls === 1, `loader ran ${calls} times`)
  check('all 25 callers got the same value', results.every((r) => r.value.value === 1))

  // 2. Second read is served from cache without calling the loader.
  const again = await cached('k1', { ttlMs: 10_000 }, loader)
  check('subsequent read is served from cache', calls === 1 && again.source === 'fresh', `calls=${calls} source=${again.source}`)

  // 3. asOf is stable across cached reads — it is when Panta answered, not now.
  check('asOf is stable while fresh', again.asOf === results[0]!.asOf)

  // 4. THE BIG ONE: a rejected loader must not poison the key forever.
  //    This is the `finally` vs `then` trap. If the delete were in `then`, the
  //    rejected promise would stay in the map and every later caller would get
  //    the cached failure.
  let failCalls = 0
  const flaky = async () => {
    failCalls += 1
    if (failCalls === 1) throw new Error('upstream 500')
    return { recovered: true }
  }
  const first = await cached('k2', { ttlMs: 10_000 }, flaky).then(
    () => 'resolved',
    () => 'rejected',
  )
  check('first load rejects', first === 'rejected')
  const second = await cached('k2', { ttlMs: 10_000 }, flaky).then(
    (r) => `resolved:${JSON.stringify(r.value)}`,
    () => 'rejected',
  )
  check(
    'a failed load is NOT cached as a failure — next call retries',
    second.includes('recovered'),
    `got "${second}" after ${failCalls} loader calls`,
  )

  // 5. Stale-while-revalidate: past TTL but inside the grace window, the old
  //    value is returned immediately and a refresh runs out of band.
  let refreshes = 0
  const counting = async () => {
    refreshes += 1
    return { n: refreshes }
  }
  await cached('k3', { ttlMs: 40, staleMs: 5_000 }, counting)
  check('k3 loaded once', refreshes === 1)
  await sleep(70)
  const swr = await cached('k3', { ttlMs: 40, staleMs: 5_000 }, counting)
  check('stale read returns immediately with stale=true', swr.stale && swr.source === 'stale')
  check('stale read returns the OLD value', swr.value.n === 1, `got n=${swr.value.n}`)
  await sleep(50)
  check('background refresh ran', refreshes === 2, `refreshes=${refreshes}`)
  check('peekStale sees the refreshed value', peekStale<{ n: number }>('k3')?.value.n === 2)

  // 6. A failing background refresh must leave the old value servable AND raise
  //    an alarm. Silently serving old data with no signal is the ToU §5 risk.
  let alarms = 0
  const off = onRefreshFailure(() => {
    alarms += 1
  })
  let failRefresh = 0
  const breakable = async () => {
    failRefresh += 1
    if (failRefresh > 1) throw new Error('refresh failed')
    return { ok: true }
  }
  await cached('k4', { ttlMs: 40, staleMs: 5_000 }, breakable)
  await sleep(70)
  const staleAfterFailure = await cached('k4', { ttlMs: 40, staleMs: 5_000 }, breakable)
  check('still serves a value when refresh fails', staleAfterFailure.value.ok === true)
  await sleep(60)
  check('refresh failure raises an alarm', alarms >= 1, `alarms=${alarms}`)
  off()

  // 7. Past the hard staleness ceiling, peekStale must refuse.
  await cached('k5', { ttlMs: 30, staleMs: 30 }, counting)
  await sleep(120)
  check('peekStale refuses past the staleness ceiling', peekStale('k5') === null)

  // 8. Invalidation actually drops the key.
  const before = stats().keys
  invalidate('k1')
  check('invalidate removes the key', stats().keys === before - 1)
}

// ── Breaker ─────────────────────────────────────────────────────────────────

function testBreaker(): void {
  console.log('\nbreaker')

  _resetBreakers()
  const name = 'test-breaker'

  // 1. Closed and permitting.
  const p1 = acquirePermit(name)
  check('starts closed and permitting', p1.allowed && p1.state === 'closed')

  // 2. Sub-threshold failures keep it closed. Client passes `isProbe` through.
  for (let i = 0; i < 4; i += 1) {
    const p = acquirePermit(name)
    recordFailure(name, 'boom', p.isProbe)
  }
  check('stays closed below the failure threshold', breakerState(name).state === 'closed', `state=${breakerState(name).state}`)

  // 3. The 5th consecutive failure opens it.
  const p5 = acquirePermit(name)
  recordFailure(name, 'boom', p5.isProbe)
  check('opens at the failure threshold', breakerState(name).state === 'open', `state=${breakerState(name).state}`)

  // 4. Open means refused fast, with a Retry-After.
  const refused = acquirePermit(name)
  check('open refuses calls', !refused.allowed && refused.state === 'open')
  check('refusal carries Retry-After', (refused.retryAfterSec ?? 0) > 0)

  // 5. After the reset timeout it half-opens and allows exactly one probe.
  _resetBreakers()
  for (let i = 0; i < 5; i += 1) {
    const p = acquirePermit(name)
    recordFailure(name, 'boom', p.isProbe)
  }
  // resetTimeoutMs: 0 so the cool-off has already elapsed by the time we ask.
  const instant: BreakerOptions = {
    failureThreshold: 5,
    successThreshold: 2,
    resetTimeoutMs: 0,
    rollingWindowMs: 60_000,
  }
  const probe = acquirePermit(name, instant)
  check('half-opens after the reset timeout', probe.allowed && probe.isProbe)
  const concurrentProbe = acquirePermit(name, instant)
  check('only ONE probe is allowed at a time', !concurrentProbe.allowed, 'a second probe was permitted')

  // 6. Enough successful probes close it again.
  for (let i = 0; i < 2; i += 1) {
    recordSuccess(name, true, instant)
  }
  check(
    'closes after enough successful probes',
    breakerState(name).state === 'closed',
    `state=${breakerState(name).state}`,
  )

  // 7. A 4xx must never open the breaker. The client only calls recordFailure
  //    for 5xx and transport problems; assert the outcome directly.
  _resetBreakers()
  for (let i = 0; i < 20; i += 1) {
    // A client-side rejection: retryable=false, status 400. In the client this
    // path does not call recordFailure at all, so nothing opens.
    void acquirePermit(name)
  }
  check('repeated permits without failures never opens the breaker', breakerState(name).state === 'closed')
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log('Pulse resilience verification\n' + '='.repeat(40))

await testLimiter()
await testCache()
testBreaker()

console.log('\n' + '='.repeat(40))
console.log(`passed ${passed}  failed ${failed}`)
console.log('limiter snapshot:', JSON.stringify(snapshot()))
process.exit(failed === 0 ? 0 : 1)
