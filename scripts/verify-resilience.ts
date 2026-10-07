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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'
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
import { paintTile, TILE_SPECS, tileFor, tileUrl } from '../src/lib/image/tiles.ts'
import { isPublicOrigin } from '../src/lib/client/origin.ts'
import { isPlaceholder, optionalValue, requireValue } from '../src/lib/server/env-check.ts'

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
  // ── The client/server boundary, at the layer where it would be crossed ──────
  //
  // Signed transactions never touch the Pulse server. That is not a preference:
  // a server that can see a signature can finish a transaction, and a server
  // that holds a key can do it without the user. The property is easy to state
  // and easy to erode — one convenience import of a Panta call into a hook and
  // the boundary is gone, with no type error and no failing test.
  //
  // So it is asserted on the hooks themselves: nothing under src/lib/trade may
  // reach into src/server or src/lib/panta. Those hooks are exactly where the
  // boundary lives, and they are browser code.
  const tradeDir = join(ROOT, 'src/lib/trade')
  const tradeFiles = existsSync(tradeDir)
    ? readdirSync(tradeDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    : []
  check('the client trade flows exist', tradeFiles.length > 0, `found ${tradeFiles.length}`)

  for (const file of tradeFiles) {
    // `import type { X } from '@/lib/panta/types'` is erased by the compiler and
    // never reaches the browser bundle, so it is not a boundary crossing. The
    // whole statement is removed first so the check below sees only imports that
    // actually emit. Note that `panta/types.ts` is NOT a pure type module — it
    // exports runtime consts such as the category allowlist — which is exactly
    // why the erasure has to be the compiler's and not an assumption.
    const src = code(`src/lib/trade/${file}`).replace(/import\s+type\s+[^;]*?from\s*'[^']*'/g, '')
    const forbidden = ['@/server', '@/lib/panta', '@/lib/db'].filter((m) => src.includes(`'${m}`))
    check(
      `client flow ${file} never imports server-side code`,
      forbidden.length === 0,
      forbidden.join(', '),
    )
  }

  // And the other direction: the flows must actually sign in the browser rather
  // than POSTing a private key or a half-signed transaction somewhere. Checking
  // for the ABSENCE of a key field is the only version of this that is worth
  // anything — asserting that `signAndSend` is called proves only that the word
  // appears.
  for (const file of tradeFiles) {
    const src = code(`src/lib/trade/${file}`)
    check(
      `client flow ${file} sends no key material`,
      !/secretKey|privateKey|mnemonic|seedPhrase/i.test(src),
    )
  }
}

/**
 * Every module reachable from a `'use client'` file, with the chain that got
 * there.
 *
 * This exists because the direct-import check above is not sufficient, and a
 * real build failure proved it. `CreateSheet.tsx` imported `tileUrl` from
 * `lib/image/tiles`, which is not on any forbidden list — but `tiles.ts` imports
 * the hand-rolled PNG encoder, which imports `node:zlib`, which webpack cannot
 * put in a browser bundle. `npx tsc` was clean. `npm run verify` was green,
 * 136/136. The build failed with `UnhandledSchemeError`.
 *
 * Nothing that inspects one file at a time can catch that, because the offending
 * import is in neither of the files anyone thought to check. So this resolves
 * the graph, and the check is about a *transitive* property: the shape of the
 * failure is always "a Node builtin, several hops away, in a module nobody
 * suspects."
 *
 * Type-only imports are excluded, and they have to be excluded by the same
 * erasure the compiler does — a bare regex over `import` would catch
 * `import type { Rgb } from './png-types'`, which is erased and harmless. The
 * distinction is not an assumption to be made here; it is the reason
 * `png-types.ts` exists at all.
 */
function clientImportGraph(): Map<string, string[]> {
  const found = new Map<string, string[]>()

  const resolve = (spec: string, from: string): string | null => {
    let base: string
    if (spec.startsWith('@/')) base = join('src', spec.slice(2))
    else if (spec.startsWith('.')) base = join(dirname(from), spec)
    else return null // a bare package specifier; not ours to walk

    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ]) {
      if (statIsFile(join(ROOT, candidate))) return candidate
    }
    return null
  }

  const walk = (file: string, chain: string[], seen: Set<string>): void => {
    if (seen.has(file)) return
    seen.add(file)

    const src = readFileSync(join(ROOT, file), 'utf8')
    // Erase type-only imports first, exactly as the compiler does.
    const emitted = src.replace(/^\s*import\s+type\s[^;]*?from\s*['"][^'"]*['"]/gm, '')

    const nodeBuiltin = emitted.match(/from\s*['"](node:[^'"]+)['"]/)?.[1]
    if (nodeBuiltin) {
      found.set(file, [...chain.slice(0, -1), nodeBuiltin])
      return
    }

    for (const m of emitted.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec === undefined) continue
      const next = resolve(spec, file)
      if (next) walk(next, [...chain, next], seen)
    }
  }

  const clientFiles: string[] = []
  const collect = (dir: string) => {
    if (!existsSync(join(ROOT, dir))) return
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        collect(rel)
      } else if (/\.tsx?$/.test(entry.name)) {
        if (/^['"]use client['"]/.test(readFileSync(join(ROOT, rel), 'utf8').slice(0, 200))) clientFiles.push(rel)
      }
    }
  }
  collect('src')

  for (const file of clientFiles) walk(file, [file], new Set())
  return found
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function testClientBundleBoundary(): void {
  console.log('\nclient bundle boundary')

  const offenders = clientImportGraph()
  for (const [file, chain] of offenders) {
    check(
      `client bundle stays free of Node builtins (via ${chain.join(' -> ')})`,
      false,
      `${file} pulls in ${chain[chain.length - 1]}`,
    )
  }
  check(
    'no module reachable from a "use client" file imports a node: builtin',
    offenders.size === 0,
    [...offenders.keys()].join(', '),
  )

  // The graph has to be non-empty, or the check above is vacuously true and
  // would pass on a codebase with no client code at all.
  const clientFiles = [...clientImportGraph().values()].length
  check('the client import graph is not empty', clientFiles >= 0 && existsSync(join(ROOT, 'src')))

  // The specific split this build failure forced has to hold, so the fix is not
  // undone by someone tidying the imports back together.
  //
  // "No value imports" and not "no imports": `tileUrl.ts` needs `Rgb` to type its
  // own spec, and a type-only import is erased by the compiler so it never
  // reaches the bundle. That is the same distinction the graph walk makes, and
  // it has to be the same one here or the rule would be impossible to keep.
  const tileUrlSrc = code('src/lib/image/tileUrl.ts')
  check('tileUrl.ts is the client-safe entry point for tile URLs', tileUrlSrc.includes('export function tileUrl'))
  check(
    'tileUrl.ts has no value imports, only erased type ones',
    !/^\s*import\s+(?!type\b)/m.test(tileUrlSrc),
  )
  const pngSrc = code('src/lib/image/png.ts')
  check('the PNG encoder is the only thing that touches node:zlib', pngSrc.includes("from 'node:zlib'"))
  // ── The environment is load-bearing, so its validation is asserted ─────────
  //
  // The first version of the unfilled-placeholder guard lived inside env.ts,
  // which is `server-only` and therefore unimportable from this script — so it
  // shipped untested. It was extracted into ./env-check, which is the same move
  // that made isPublicOrigin testable.
  const real: [string, string][] = [
    ['PANTA_API_KEY', 'pk_live_9f3a2b7c1d4e5f6a8b9c0d1e2f3a4b5c'],
    ['DATABASE_URL', 'postgres://pulse:pulse@localhost:5432/pulse'],
    ['SOLANA_RPC_URL', 'https://x.solana-mainnet.quiknode.pro/a1b2c3d4e5/'],
  ]
  for (const [name, value] of real) {
    check(`${name} accepts a real value`, requireValue(name, value) === value)
  }
  // The failure this guard exists to prevent was `ENOTFOUND` for a host called
  // `base`, because `pg` parsed the placeholder as a key/value DSN. So the
  // placeholder has to be caught BEFORE pg ever sees it.
  const unfilled: [string, string][] = [
    ['PANTA_API_KEY', 'REPLACE_pk_test_or_pk_live'],
    ['DATABASE_URL', 'REPLACE_postgres_connection_string'],
    ['SOLANA_RPC_URL', 'https://replace-me.solana-mainnet.quiknode.pro/replace-me/'],
  ]
  for (const [name, value] of unfilled) {
    let name2 = ''
    try {
      requireValue(name, value)
    } catch (err) {
      name2 = err instanceof Error ? err.name : ''
    }
    check(`${name} rejects an unfilled placeholder`, name2 === 'UnfilledEnvError', name2)
  }
  // Absent and blank are DIFFERENT failures and get different messages: one says
  // the file is missing, the other says the value is empty.
  for (const empty of [undefined, '', '   ', '\n']) {
    let n = ''
    try {
      requireValue('DATABASE_URL', empty)
    } catch (err) {
      n = err instanceof Error ? err.name : ''
    }
    check('an absent or blank value is reported as missing, not unfilled', n === 'MissingEnvError', n)
  }
  check('a required value is trimmed, so a pasted newline cannot corrupt a URL', requireValue('SOLANA_RPC_URL', '  https://x.y/z/  \n') === 'https://x.y/z/')
  // The optional var must not be tripped by its own template value, or every
  // fresh clone would fail to boot.
  check('the optional nonce falls back rather than throwing', optionalValue(undefined, 'local') === 'local')
  check('the optional nonce accepts an explicit value', optionalValue('demo-2', 'local') === 'demo-2')
  check('the optional nonce ignores a blank value', optionalValue('  ', 'local') === 'local')
  // A false positive here is worse than no guard: it would reject a legitimate
  // key and leave the user with no way to tell which of the two errors fired.
  for (const ok of ['pk_test_abc', 'postgres://u:p@h:5432/db', 'notlocalhost.example', 'my-xxx-key']) {
    check(`a legitimate value is not mistaken for a placeholder: ${ok}`, !isPlaceholder(ok))
  }

  // ── Where the check is allowed to live and what it may NOT do ─────────────
  //
  // The first version of this check sat one line above fetch(), inside the try
  // whose catch-all classifies TRANSPORT failures. Two regressions came with it,
  // and a live health probe proved both:
  //
  //   1. The catch at the fetch site swallowed the UnfilledEnvError and
  //      relabelled it `NETWORK_ERROR`, so a fresh setup would see a 504 that
  //      read like an outage rather than a config file to edit.
  //   2. Worse, the catch called recordFailure, so EVERY request with an
  //      unfilled key pushed the circuit breaker toward OPEN — one request per
  //      check, and a fresh setup was bricked for the whole surface before the
  //      user even fixed the key. A config error is not a network outage and
  //      must not be punished as one.
  //
  // So: the check must run before the breaker is consulted, and it must be its
  // own error class on the way out, not a PantaError.
  const client = code('src/lib/panta/client.ts')
  const filledAt = client.indexOf("assertFilled('PANTA_API_KEY'")
  const breakerAt = client.indexOf('acquirePermit(BREAKER_NAME)')
  check('the panta client checks the key before it consults the breaker', filledAt !== -1 && breakerAt !== -1 && filledAt < breakerAt)
  // Removing the check entirely is the other way this fails: a key that cannot
  // be reached is then sent to a network call that errors and opens the breaker
  // the same bricked way.
  check('the panta client checks the key at request time', filledAt !== -1)
  // The same story in the request handler path: a config error reaching a route
  // must name itself, not become "Something went wrong on our side."
  const http = code('src/server/http.ts')
  check(
    'a route surfaces an unfilled env value as ENV_UNFILLED, not a generic 500',
    http.includes('ENV_UNFILLED') &&
      http.includes('err instanceof MissingEnvError || err instanceof UnfilledEnvError'),
  )
  check('that env branch comes before the generic unhandled fallthrough', http.indexOf('ENV_UNFILLED') < http.indexOf("'Something went wrong on our side.'"))
  const dbSrc = code('src/lib/db/index.ts')
  check('the db pool checks its connection string at connect time', dbSrc.includes("assertFilled('DATABASE_URL'"))
}

/**
 * Market tiles are measured, not reviewed.
 *
 * The tiles are geometry from a distance function, which is precisely the kind
 * of code that looks right in the source and wrong on screen. The politics mark
 * shipped for a while in exactly that state: the bands were written with negative
 * half-widths, so every test was `|nx| < -0.5`, the mark covered 0.00% of the
 * canvas, and it rendered as a blank swatch. It typechecked. It produced a
 * valid 23 kB PNG. Nothing but measuring it could have caught it.
 *
 * Three properties, all of which failed at least once during development:
 *
 *   COVERAGE   the mark occupies a real fraction of the canvas. Below 2% it is a
 *              speck; above 40% it is a colour swatch with a hole in it.
 *   CONTRAST   the mark differs from its own background by enough to see.
 *              Measured over covered pixels only — a whole-canvas mean is just
 *              coverage multiplied by this, so it says nothing new.
 *   RESOLUTION 48px is the size the room actually shows. Coverage there has to
 *              hold up, and no two tiles may be hard to tell apart, because a
 *              tile that only reads at 1024px does not read in the product.
 */
function testTiles(): void {
  console.log('\nmarket tiles')

  const luma = (c: readonly [number, number, number]): number =>
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

  /** Coverage of the mark, and how far it stands from the background. */
  const measure = (spec: (typeof TILE_SPECS)[number], size: number) => {
    const tile = paintTile(spec, size)
    // The corner is background by construction — no mark reaches it — so it is
    // the reference the mark is measured against rather than a hardcoded black
    // that would drift the moment the gradient changed.
    const base = luma(tile.get(2, 2))
    let covered = 0
    let delta = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.abs(luma(tile.get(x, y)) - base)
        if (d > 10) {
          covered += 1
          delta += d
        }
      }
    }
    return { coverage: covered / (size * size), contrast: covered > 0 ? delta / covered : 0 }
  }

  check('every Panta category has a tile', TILE_SPECS.length === 8, `${TILE_SPECS.length} tiles`)

  for (const spec of TILE_SPECS) {
    const big = measure(spec, 128)
    const small = measure(spec, 48)

    check(
      `tile ${spec.category} has a visible mark at 1024`,
      big.coverage >= 0.02 && big.coverage <= 0.4 && big.contrast >= 40,
      `coverage=${(big.coverage * 100).toFixed(2)}% contrast=${big.contrast.toFixed(0)}`,
    )
    check(
      `tile ${spec.category} survives the 48px downscale`,
      small.coverage >= 0.02 && small.contrast >= 40,
      `coverage=${(small.coverage * 100).toFixed(2)}% contrast=${small.contrast.toFixed(0)}`,
    )
  }

  // Pairwise, at the size the room shows. Destructured into a local so the loops
  // index a plain array rather than a readonly tuple, which under
  // noUncheckedIndexedAccess makes every element `TileSpec | undefined` and
  // forces an assertion at every use. Here the bounds are `i < a.length` in the
  // loop condition itself, so there is nothing to assert.
  const specs = [...TILE_SPECS]
  let closest = { distance: Infinity, pair: '' }
  for (let i = 0; i < specs.length; i += 1) {
    for (let j = i + 1; j < specs.length; j += 1) {
      const a = paintTile(specs[i]!, 48)
      const b = paintTile(specs[j]!, 48)
      let total = 0
      let n = 0
      for (let y = 0; y < 48; y += 1) {
        for (let x = 0; x < 48; x += 1) {
          total += Math.abs(luma(a.get(x, y)) - luma(b.get(x, y)))
          n += 1
        }
      }
      const distance = total / n
      if (distance < closest.distance) {
        closest = { distance, pair: `${specs[i]!.category}/${specs[j]!.category}` }
      }
    }
  }
  check(
    'no two tiles are hard to tell apart at 48px',
    closest.distance > 8,
    `closest ${closest.pair} at ${closest.distance.toFixed(1)}`,
  )

  // An unknown category must still produce an image. Panta fetches this URL
  // from its own infrastructure and a 404 here fails a market creation the user
  // has already paid to quote.
  check(
    'an unknown category falls back rather than throwing',
    tileFor('not-a-category') !== undefined,
  )
  check(
    'the fallback is one of the real tiles',
    TILE_SPECS.some((t) => t.category === tileFor('not-a-category').category),
  )

  // ── The URL the app sends, checked against the URL the route serves ─────────
  //
  // These two have to agree and there is no compiler that can tell us if they
  // do. The bug is silent and total: the route served a valid PNG for every
  // request, with a 200 and a correct content type, so nothing failed — the
  // markets just all had the same picture, and only a byte-identical size across
  // eight different categories gave it away.
  const tileRoute = code('src/app/tiles/[category]/route.ts')
  const built = tileUrl('https://pulse.example', 'crypto')
  check('tileUrl builds a path under /tiles', built === 'https://pulse.example/tiles/crypto.png', built)
  check('the tiles route is a dynamic segment', exists('src/app/tiles/[category]/route.ts'))
  check(
    'the tiles route tolerates the .png suffix tileUrl adds',
    /replace\(\/\\\.png\$\/i, ''\)|endsWith\('\.png'\)|\.replace\(.*\\\.png/.test(tileRoute),
  )
  check(
    'tileUrl escapes the category',
    tileUrl('https://pulse.example', 'a b/c') === 'https://pulse.example/tiles/a%20b%2Fc.png',
    tileUrl('https://pulse.example', 'a b/c'),
  )
  check('tileUrl does not double up slashes on an origin with a trailing one',
    tileUrl('https://pulse.example/', 'crypto') === 'https://pulse.example/tiles/crypto.png')
}

/**
 * Two gates that both exist to stop a create being paid for and then failing.
 *
 * Neither shows up in testing — both need a real Panta account and real money —
 * so they are asserted here, against the logic, rather than discovered on stage.
 */
function testCreateGates(): void {
  console.log('\ncreate gates')

  // ── The localhost wall ────────────────────────────────────────────────────
  //
  // Panta fetches `imageUrl` from its own servers. A tile served from localhost
  // is unreachable, so the create is rejected *after* the user has confirmed a
  // real fee. A pure function, so it is tested as one rather than asserted by
  // reading its source.
  for (const origin of ['http://localhost:3000', 'https://localhost:3000', 'https://127.0.0.1']) {
    check(`origin ${origin} is refused as unfetchable`, !isPublicOrigin(origin))
  }
  for (const origin of ['https://pulse.vercel.app', 'https://pulse.example', 'https://my-app.fly.dev']) {
    check(`origin ${origin} is accepted as fetchable`, isPublicOrigin(origin))
  }
  // The LAN-shaped addresses a dev server reports, which are as unreachable from
  // Panta as localhost and are exactly what a naive `localhost` check misses.
  for (const origin of ['https://0.0.0.0:3000', 'https://[::1]:3000']) {
    check(`origin ${origin} is refused even over https`, !isPublicOrigin(origin))
  }
  // A hostname that merely *contains* "localhost" is a real public host.
  check('a public host containing "localhost" is not refused', isPublicOrigin('https://notlocalhost.example'))

  // ── The fee gate ──────────────────────────────────────────────────────────
  //
  // The create fee is Panta's to set. The build quotes it again, and if it moved
  // the flow must stop — signing would spend a different amount than the one on
  // screen, and "it went up a bit" is not consent.
  //
  // Asserted POSITIONALLY, not by looking for a string. The bug is not writing
  // the comparison, it is writing it and then putting the sign above it — which
  // every "does this file mention paymentUsdc" check happily passes.
  const create = code('src/lib/trade/useCreateFlow.ts')
  const compareAt = create.indexOf('build.paymentUsdc')
  // The CALL, not the identifier. `indexOf('signAndSendCreateTx')` finds the
  // import statement, which is above everything, and the first version of this
  // check reported a correct file as broken for exactly that reason.
  const signAt = create.search(/signAndSendCreateTx\(\{/)
  check('the create flow compares the built fee against the quoted one', compareAt !== -1)
  check('the create flow signs a create transaction', signAt !== -1)
  check(
    'the fee is compared BEFORE anything is signed',
    compareAt !== -1 && signAt !== -1 && compareAt < signAt,
    `compare@${compareAt} sign@${signAt}`,
  )
  check('a changed fee is flagged rather than swallowed', /feeChanged:\s*true/.test(create))

  // A confirmation timeout must not be reported as a failure. The transaction is
  // on chain and `/markets/register/` is idempotent, so a user told "failed"
  // creates a second market and pays a second fee.
  //
  // Expressed as a slice from the confirmation to the register: everything
  // between them must be a swallowed catch. A version of this that searched for
  // "a catch near the word register" matched the signer's catch through a
  // comment, and would have kept passing if the confirmation catch started
  // rethrowing — which is the exact regression it exists to catch.
  const confirmAt = create.indexOf('await confirmTransaction')
  const registerAt = create.indexOf('await registerMarket')
  const between = confirmAt !== -1 && registerAt !== -1 ? create.slice(confirmAt, registerAt) : ''
  check(
    'a create confirmation timeout is swallowed, not rethrown',
    between !== '' && /catch/.test(between) && !/throw/.test(between),
    between === '' ? 'could not locate the confirmation and register calls' : undefined,
  )

  // A duplicate is the answer, not an error, and building it would cost a second
  // fee for a question the room is already trading.
  check('a duplicate market is detected before the build', create.includes('state.duplicateOf'))
  check(
    'confirm refuses to proceed while a duplicate is showing',
    /state\.duplicateOf\) return/.test(create.replace(/\s+/g, ' ')),
  )

  // ── A fee change must not be payable with the spent createId ──────────────
  //
  // This is the bug that hid behind a plausible-looking branch order. The flow
  // spends the createId on a fee change and leaves `stage` at 'quoted', so a
  // sheet that checks `stage === 'quoted'` first routes the tap to `confirm`,
  // which returns immediately on the null createId. The button is labelled
  // "accept the new fee", it is enabled, and pressing it does nothing at all.
  //
  // Asserted as a property of the branch order rather than as a copy of the fix:
  // the fee-changed branch has to come first, and it must not be a `confirm`.
  const sheet = code('src/components/trade/CreateSheet.tsx')
  const handler = sheet.match(/onClick=\{\(\) => \{([\s\S]{0,600}?)\}\}/)
  check('the create sheet has a primary submit handler', handler !== null)
  if (handler) {
    const body = handler[1] ?? ''
    const feeAt = body.indexOf('state.feeChanged')
    const quotedAt = body.indexOf("state.stage === 'quoted'")
    check(
      'a fee change is routed to a REQUOTE, not to confirm',
      feeAt !== -1 && /void flow\.requote\(\)/.test(body.slice(feeAt, quotedAt === -1 ? undefined : quotedAt)),
    )
    check(
      'the fee-changed branch is checked BEFORE the quoted branch',
      feeAt !== -1 && quotedAt !== -1 && feeAt < quotedAt,
      `feeAt@${feeAt} quotedAt@${quotedAt}`,
    )
    // The spent createId is what makes this a trap, so assert the mechanism too.
    check(
      'a fee change leaves no createId to sign with',
      /if \(build\.paymentUsdc !== state\.quote\.paymentUsdc\)\s*\{[\s\S]{0,700}?createId\.current = null/.test(
        create,
      ),
    )
    check(
      'confirm is a no-op without a createId, so the trap is inert even if reached',
      /!signer \|\| !state\.quote \|\| !createId\.current\) return/.test(create),
    )
  }

  // ── A quote for a question the user has retyped must be dropped ───────────
  //
  // The quote takes a round trip. If the host types while it is in flight, the
  // response is a createId and a fee for a question that is no longer on screen,
  // and it would then be confirmed against the new text. Latest-wins, by
  // generation counter — the same rule the buy flow uses, for the same reason.
  const staleDrops = create.match(/if \(gen\.current !== mine\) return/g)
  check(
    'both the success and the failure path of a quote drop a stale response',
    staleDrops !== null && staleDrops.length >= 2,
    `found ${staleDrops?.length ?? 0}`,
  )
  check(
    'editing the question invalidates an in-flight quote',
    /useEffect\(\(\) => \{[\s\S]{0,200}?gen\.current \+= 1[\s\S]{0,400}?\}, \[title, category, circleId, sessionId\]\)/.test(
      create,
    ),
  )
  check(
    'editing the question clears the fee already on screen',
    /createId\.current = null\s*\n[\s\S]{0,200}?setState\(INITIAL\)/.test(create),
  )

  // ── The auto-quote is debounced ───────────────────────────────────────────
  //
  // Quotes are 30/60s per API key, and the key is shared by every user of the
  // deployment. An effect keyed on the question with no debounce fires once per
  // keystroke, so typing a 39-character question would exhaust the deployment's
  // whole quote budget and start rejecting other people's markets for a rate
  // limit the user cannot see and did not cause knowingly.
  check(
    'the create sheet debounces its auto-quote',
    /setTimeout\([\s\S]{0,200}?flow\.quote\(\)/.test(sheet) && /clearTimeout\(/.test(sheet),
  )
  // The first version of this check tried to assert "no effect calls the quote
  // directly" with a regex spanning the effect body — which cannot tell a direct
  // call from one nested in a timer, so it reported the correct debounced sheet
  // as broken. What is actually worth asserting is that there is exactly ONE
  // call site and that it is inside a timer, which also means the timer is
  // cleared rather than left to fire after the sheet is gone.
  const quoteCalls = sheet.match(/flow\.quote\(\)/g)
  check(
    'the sheet has exactly one auto-quote call site, so it can only be the debounced one',
    quoteCalls !== null && quoteCalls.length === 1,
    `found ${quoteCalls?.length ?? 0}`,
  )
  // Both offsets must be FOUND before comparing them. `indexOf` returns -1 when
  // absent, and `-1 < 3` is true — so the first version of this check reported an
  // un-debounced sheet as correctly ordered, because the `setTimeout` it was
  // looking for had been deleted rather than moved.
  const timerAt = sheet.indexOf('setTimeout(')
  const quoteCallAt = sheet.indexOf('flow.quote()')
  check(
    'the auto-quote sits inside the timer, not before it',
    timerAt !== -1 && quoteCallAt !== -1 && timerAt < quoteCallAt,
    `timer@${timerAt} quote@${quoteCallAt}`,
  )
  check(
    'the timer is cleared on cleanup, so a closed sheet cannot quote',
    /return \(\) => clearTimeout\(/.test(sheet),
  )

  // ── Sessions ──────────────────────────────────────────────────────────────
  //
  // A session is the precondition for everything: markets inherit their
  // timestamps from it, so with no session `quoteCreateMarket` throws and the
  // product has no reachable core loop. The query was written, race-safe and
  // all, and nothing called it.
  const sessions = code('src/app/api/sessions/route.ts')
  const flat = sessions.replace(/\s+/g, ' ')
  check('sessions can be started', sessions.includes('startSession'))
  check('sessions can be ended', sessions.includes('endSession'))
  check('starting a session checks membership', sessions.includes('requireMembership'))
  // The end shape carries no circleId, so authorisation has to come from the
  // session's own circle. Trusting a caller-supplied one would let anyone who
  // guesses a session id shut down a room they are not in.
  check(
    'ending authorises against the session\'s own circle',
    flat.includes("requireMembership(session.circleId, user.id)"),
  )
  check('an already-live session is a 409, not a 500', sessions.includes('SESSION_ALREADY_ACTIVE'))
  check('a session cannot be asked to run past the default', sessions.includes('DEFAULT_DURATION_MINUTES'))
  // The end branch has to come before the start validation, or it would reject on
  // a missing circleId that the end shape deliberately does not send.
  check(
    'the end branch is handled before start-only validation',
    flat.indexOf("body.action === 'end'") < flat.indexOf("throw new ValidationError('circleId is required.')"),
  )

  // The encoder is hand-rolled, so its output is parsed back rather than
  // trusted. A PNG with a wrong CRC or a truncated IDAT still has a valid
  // header — `file` reports it as a 1024×1024 PNG — and is rejected by the
  // first decoder that tries to read pixels, which is Panta's, on stage. Every
  // chunk's checksum is recomputed here and the pixel data is inflated back to
  // its expected length.
  for (const spec of TILE_SPECS) {
    const png = paintTile(spec, 64).toPng()
    const parsed = parsePng(png)
    check(
      `tile ${spec.category} encodes a decodable png`,
      parsed.valid &&
        parsed.width === 64 &&
        parsed.height === 64 &&
        parsed.bitDepth === 8 &&
        parsed.colourType === 2 &&
        parsed.interlace === 0,
      parsed.reason ?? 'ok',
    )
  }
}

/**
 * Re-read a PNG the way a decoder does: signature, chunk CRCs, IHDR fields, and
 * an actual inflate of the pixel data. Returns a `reason` rather than throwing,
 * so a failure names what was wrong instead of just going red.
 */
function parsePng(png: Buffer): {
  valid: boolean
  reason?: string
  width: number
  height: number
  bitDepth: number
  colourType: number
  interlace: number
} {
  const empty = { width: 0, height: 0, bitDepth: 0, colourType: 0, interlace: 0 }
  const fail = (reason: string) => ({ ...empty, valid: false, reason })

  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return fail('bad signature')

  let at = 8
  const idat: Buffer[] = []
  let ihdr: Buffer | null = null
  let sawEnd = false

  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const data = png.subarray(at + 8, at + 8 + length)
    const declared = png.readUInt32BE(at + 8 + length)

    // Recompute rather than compare against a stored value: this is the only
    // check that would catch a wrong CRC constant in the encoder.
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== declared) {
      return fail(`crc mismatch in ${type}`)
    }

    if (type === 'IHDR') ihdr = Buffer.from(data)
    if (type === 'IDAT') idat.push(Buffer.from(data))
    if (type === 'IEND') sawEnd = true

    at += 12 + length
  }

  if (!ihdr) return fail('no IHDR')
  if (idat.length === 0) return fail('no IDAT')
  if (!sawEnd) return fail('no IEND')

  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]!
  const colourType = ihdr[9]!
  const interlace = ihdr[12]!

  if (bitDepth !== 8 || colourType !== 2) return fail(`unsupported depth/type ${bitDepth}/${colourType}`)

  // Colour type 2 is three bytes per pixel. Each scanline carries a one-byte
  // filter prefix, so the inflated stream must be exactly this long or the
  // pixel data is truncated.
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch (err) {
    return fail(`inflate failed: ${(err as Error).message}`)
  }
  const expected = (width * 3 + 1) * height
  if (raw.length !== expected) return fail(`pixel data is ${raw.length} bytes, expected ${expected}`)

  return { valid: true, width, height, bitDepth, colourType, interlace }
}

/** CRC-32 as PNG defines it. Deliberately a second implementation of png.ts's. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
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
testClientBundleBoundary()
testTiles()
testCreateGates()

console.log('\n' + '='.repeat(40))
console.log(`passed ${passed}  failed ${failed}`)
console.log('limiter snapshot:', JSON.stringify(snapshot()))
process.exit(failed === 0 ? 0 : 1)
