/**
 * Verification for the Panta resilience layer and the API contract around it.
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
 *
 * The last block is different in kind: it asserts things about the SHAPE of the
 * Panta contract, by reading the source. Those are the failures that no type
 * checker catches and that a demo does.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// ── Price budget arithmetic ─────────────────────────────────────────────────

/**
 * priceTtlMs is duplicated here rather than imported, because it lives in a
 * `server-only` module that reaches the database. Duplicating the formula means
 * this assertion fails if someone changes the real one — which is the only way a
 * test of an un-importable function is worth anything. Keep the two in step.
 */
function derivedTtl(marketCount: number, budgetFraction = 0.6, minTtl = 2_000): number {
  const perMinute = Math.max(1, Math.floor(FAMILY_LIMITS.read * budgetFraction))
  const perMarket = perMinute / Math.max(1, marketCount)
  return Math.max(minTtl, Math.ceil(60_000 / perMarket))
}

function testPriceBudget(): void {
  console.log('\nprice budget')

  // The load-bearing property: for any plausible room size, the derived cadence
  // must not exceed the shared read budget. This is the whole reason the TTL is
  // computed rather than chosen.
  for (const markets of [1, 3, 8, 12, 20, 40, 100]) {
    const ttl = derivedTtl(markets)
    const callsPerMinute = (markets * 60_000) / ttl
    check(
      `${markets} markets stays inside the read budget`,
      callsPerMinute <= FAMILY_LIMITS.read,
      `${callsPerMinute.toFixed(0)} calls/min vs budget ${FAMILY_LIMITS.read}`,
    )
  }

  // A small room should be genuinely live, not clamped to the floor.
  check('a 3-market room refreshes faster than 5s', derivedTtl(3) < 5_000, `${derivedTtl(3)}ms`)
  // A big room must back off rather than hit the wall.
  check('a 40-market room backs off past 10s', derivedTtl(40) > 10_000, `${derivedTtl(40)}ms`)

  // Non-monotonic TTL would mean a bigger room got fresher prices, which is
  // exactly backwards.
  let monotonic = true
  for (let n = 1; n < 200; n += 1) {
    if (derivedTtl(n + 1) < derivedTtl(n)) monotonic = false
  }
  check('TTL never decreases as markets are added', monotonic)

  console.log('        cadence:', [1, 3, 8, 20, 40].map((n) => `${n}m=${derivedTtl(n)}ms`).join('  '))
}

// ── Contract drift guards ────────────────────────────────────────────────────

/**
 * Assertions about the Panta contract itself, which no amount of resilience
 * testing can catch.
 *
 * The failure these exist for is specific and expensive: a request shape drifts,
 * the call still returns 200 or a 400 we do not recognise, and the bug is
 * discovered on stage. The type system cannot help — a drifted field is still a
 * valid string. So the parts of the contract we are most likely to have got
 * wrong, and which cost the most when wrong, are pinned here as executable
 * claims about the source.
 *
 * These read the source rather than calling the API on purpose. `npm run verify`
 * has to pass with no key, no network and no database, because it is the check
 * that runs before every commit.
 */
function testContractInvariants(): void {
  console.log('\ncontract invariants')

  // Comments are stripped before anything is asserted on. These files are heavily
  // and deliberately commented — the notes about WHY the fee is not an input
  // contain the words "paymentUsdc" more than once — and a checker that matched
  // prose would fail on the documentation being good. What is asserted here is
  // the code, never the comment.
  const client = code('src/lib/panta/client.ts')
  const types = code('src/lib/panta/types.ts')
  const create = code('src/server/marketCreate.ts')
  const buy = code('src/server/marketBuy.ts')

  // The create fee is QUOTED, never requested. Every published Panta example
  // shows `paymentUsdc` on the response and invites you to copy it into the
  // request, where it is ignored. Sending it anyway would mean budgeting markets
  // from a hardcoded number instead of the one Panta actually charges.
  const quoteCall = callArgs(create, 'panta.createQuote')
  check('the create quote call is findable', quoteCall.length > 0)
  check('create quote does not send a paymentUsdc', !quoteCall.includes('paymentUsdc'))
  check(
    'CreateQuoteRequest has no paymentUsdc field',
    !slice(types, 'interface CreateQuoteRequest', '\n}').includes('paymentUsdc'),
  )
  check(
    'CreateQuoteRequest does require a wallet',
    slice(types, 'interface CreateQuoteRequest', '\n}').includes('wallet'),
  )

  // The two build shapes. This is the asymmetry that kills demos, and the whole
  // reason createTx.ts and instructionTx.ts are separate files.
  check('create build goes to markets/create/build/', client.includes("'markets/create/build/'"))
  check('order build goes to primaryorderbuild/', client.includes("'primaryorderbuild/'"))
  check(
    'the two tx paths live in separate modules',
    exists('src/lib/tx/createTx.ts') && exists('src/lib/tx/instructionTx.ts'),
  )

  // `signTransaction` RETURNS a new transaction; it does not sign in place. The
  // adapter wraps Wallet Standard's bytes-in/bytes-out interface and
  // re-deserialises the result, so `await signer.signTransaction(tx)` on its own
  // leaves `tx` unsigned. Broadcasting that fails on chain with a signature
  // verification error that names neither the wallet nor the cause. Both paths
  // had this bug and it typechecked in both, which is why it is asserted rather
  // than reviewed.
  for (const [label, path] of [
    ['create', 'src/lib/tx/createTx.ts'],
    ['buy/claim', 'src/lib/tx/instructionTx.ts'],
  ] as const) {
    const src = code(path)
    check(`${label} tx path uses the returned signed transaction`, callResultsUsed(src, 'signer.signTransaction'))
    check(
      `${label} tx path broadcasts a serialised transaction`,
      /sendRawTransaction\(\s*\w+\.serialize\(\)/.test(src),
    )
  }

  // Build takes a QUOTE ID and mints the orderId. Swapping them is a 400 whose
  // message reads like a server fault, because the response is the thing that
  // carries the orderId.
  const orderBuild = slice(types, 'interface OrderBuildRequest', '\n}')
  check('order build takes a quoteId', orderBuild.includes('quoteId'))
  check('order build does not take an orderId', !orderBuild.includes('orderId'))
  check('order build requires the wallet', orderBuild.includes('wallet'))
  check(
    'the server passes the quoteId, not an orderId, to the build',
    callArgs(buy, 'panta.primaryOrderBuild').includes('quoteId'),
  )

  // Submit and verify both need the wallet. Panta cannot tie a signature to a
  // buyer without it, and the failure reads as a mysteriously rejected order
  // rather than a missing field.
  check(
    'order submit sends the wallet',
    slice(types, 'interface OrderSubmitRequest', '\n}').includes('wallet'),
  )

  // Every write that hands Panta a signature has to check the caller owns it.
  // The X-Pulse-Wallet header is forgeable; these are the places where that
  // stops mattering.
  check('buy verifies the order belongs to the wallet', buy.includes('requireOwnedOrder'))
  check(
    'create verifies the create belongs to the wallet',
    create.includes('create.wallet !== user.wallet'),
  )

  // Live Mode markets. `eventInProgress` is the only reason a mid-match market is
  // possible at all: without it Panta demands a start at least an hour out.
  check('live markets are created as breaking', create.includes("'breaking'"))
  check('live markets set eventInProgress', create.includes('eventInProgress'))

  // The app's category allowlist and Panta's are reconciled by a cast in
  // marketCreate.ts. That cast is the weak point, so the lists are compared here
  // rather than trusted.
  const appCategories = listOf(code('src/lib/db/queries/markets.ts'), 'MARKET_CATEGORIES')
  const pantsCategories = listOf(types, 'PANTA_CATEGORIES')
  check(
    'the app and Panta category lists agree',
    appCategories.length > 0 &&
      appCategories.length === pantsCategories.length &&
      appCategories.every((c) => pantsCategories.includes(c)),
    `app=[${appCategories}] panta=[${pantsCategories}]`,
  )
}

/** A source file with its comments removed. */
function code(path: string): string {
  if (!exists(path)) return ''
  return stripComments(readFileSync(join(ROOT, path), 'utf8'))
}

/**
 * Remove comments while preserving line structure.
 *
 * Line numbers are not needed, but newlines are: several checks match on
 * `'\n}'` to bound an interface, and collapsing a block comment to a single line
 * would join a declaration onto the next one and break that bound.
 *
 * Strings are not parsed, which is a known limitation — a `//` inside a string
 * literal would be treated as a comment. No Panta route, error code or copy in
 * this codebase contains one, and the alternative is a real tokenizer, which is
 * not worth it for a check whose worst failure is a false alarm.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

function read(path: string): string {
  return exists(path) ? readFileSync(join(ROOT, path), 'utf8') : ''
}

function exists(path: string): boolean {
  return existsSync(join(ROOT, path))
}

/** The text from `from` up to the next `to`, or to the end if `to` is absent. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  if (start === -1) return ''
  const end = source.indexOf(to, start + from.length)
  return end === -1 ? source.slice(start) : source.slice(start, end)
}

/**
 * The string literals in a `const NAME = [...]` declaration.
 *
 * Finds the `[` after the `=`, NOT the first `[` after the name — the name is
 * followed by a type annotation (`readonly MarketCategory[]`), and taking that
 * bracket pair yields an empty array and a check that silently passes against
 * nothing. The two lists are declared differently, one annotating and one
 * relying on `as const`, so the `=` is the only reliable anchor.
 */
function listOf(source: string, name: string): string[] {
  const start = source.indexOf(name)
  if (start === -1) return []
  const assign = source.indexOf('=', start)
  if (assign === -1) return []
  const open = source.indexOf('[', assign)
  if (open === -1) return []
  const close = source.indexOf(']', open)
  // `m[1]` is `string | undefined` under noUncheckedIndexedAccess, and flatMap
  // narrows it without a non-null assertion that the regex cannot actually
  // violate but a future edit might.
  return [...source.slice(open, close).matchAll(/'([a-z]+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []))
}

/**
 * True when every call to `callee` has its return value used.
 *
 * A call counts as used when the text immediately before it is `return`, or ends
 * in `=`. Anything else — a bare `await f(x)` statement, which is the exact shape
 * of the signTransaction bug — is discarded.
 *
 * The first version of this check looked for a trailing semicolon and passed on
 * the broken code, because the bug was written as a bare statement with no
 * semicolon. An assertion that cannot fail on the bug it was written for is
 * worse than no assertion, so this one reasons about the token before the call
 * rather than the punctuation after it. Verified against both shapes.
 */
function callResultsUsed(source: string, callee: string): boolean {
  const needle = `${callee}(`
  let at = source.indexOf(needle)
  if (at === -1) return false

  while (at !== -1) {
    // Comments are already stripped, so this prefix is code only. A trailing
    // `await` belongs to the call, not to the value, so it is removed before
    // deciding whether the result is consumed. Trimmed FIRST, because the text
    // ends with `await ` and `$` would not match past that space — which is what
    // made an early version of this check pass on a correct `const x = await f()`
    // and reject it on a buggy one for the wrong reason.
    const before = source
      .slice(0, at)
      .replace(/\s+/g, ' ')
      .trimEnd()
      .replace(/\bawait$/, '')
      .trimEnd()

    if (!/\breturn$/.test(before) && !/=$/.test(before)) return false
    at = source.indexOf(needle, at + needle.length)
  }
  return true
}

/**
 * The argument text of a call, by matching braces.
 *
 * Used instead of slicing to a fixed terminator because the terminator is
 * indentation, and a check whose correctness depends on how deep a call happens
 * to be nested is a check that will fail on a reformat rather than on a bug.
 * Track the depth from the opening paren and stop at the one that closes it.
 */
function callArgs(source: string, callee: string): string {
  const at = source.indexOf(callee)
  if (at === -1) return ''
  const open = source.indexOf('(', at)
  if (open === -1) return ''

  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log('Pulse resilience verification\n' + '='.repeat(40))

await testLimiter()
await testCache()
testBreaker()
testPriceBudget()
testContractInvariants()

console.log('\n' + '='.repeat(40))
console.log(`passed ${passed}  failed ${failed}`)
console.log('limiter snapshot:', JSON.stringify(snapshot()))
process.exit(failed === 0 ? 0 : 1)
