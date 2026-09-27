import { NextResponse } from 'next/server'
import { panta, PantaError } from '@/lib/panta/client'
import { snapshot as limiterSnapshot } from '@/lib/panta/limiter'
import { breakerState } from '@/lib/panta/breaker'
import { stats as cacheStats } from '@/lib/panta/cache'
import { dbStatsPlaceholder } from '@/lib/db/stats'
import { redactRpcUrl } from '@/lib/server/env'

/**
 * GET /api/ops/health
 *
 * The day-1 de-risk check, and the thing to look at first when the demo breaks.
 *
 * ⚠ It reports `canCreateMarkets`. If that is false, market creation will fail
 * on stage and no amount of UI polish saves it. Check this before every rehearsal.
 *
 * Never returns the API key, the RPC token, or any Panta response body verbatim.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {}
  let canCreateMarkets: boolean | null = null

  // 1. Panta reachability + capability. The single most important check.
  try {
    const { value } = await panta.account()
    canCreateMarkets = value.canCreateMarkets
    checks.panta = {
      ok: true,
      detail: `reachable, canCreateMarkets=${value.canCreateMarkets}`,
    }
    if (!value.canCreateMarkets) {
      checks.panta.ok = false
      checks.panta.detail += ' — CREATION WILL FAIL. Contact Panta before the demo.'
    }
  } catch (err) {
    checks.panta = {
      ok: false,
      detail: err instanceof PantaError ? `${err.code}: ${err.userMessage}` : String(err),
    }
  }

  // 2. The live-price path, which is what the whole UI depends on.
  try {
    const { value, asOf, stale } = await panta.market('probe-nonexistent')
    checks.pricePath = { ok: true, detail: `ok (${value.marketId}, stale=${stale})` }
    void asOf
  } catch (err) {
    const code = err instanceof PantaError ? err.code : 'UNKNOWN'
    // A 404 here is EXPECTED — we probed a market that does not exist. It still
    // proves the route, the key, and the error mapping all work end to end.
    checks.pricePath = {
      ok: code === 'MARKET_NOT_FOUND',
      detail:
        code === 'MARKET_NOT_FOUND'
          ? 'route + key verified (404 as expected for a probe id)'
          : `${code}: ${err instanceof PantaError ? err.userMessage : String(err)}`,
    }
  }

  // 3. Categories, cached hard. If this fails, the create form has no chips.
  try {
    const { value } = await panta.categories()
    const count = Array.isArray(value) ? value.length : 0
    checks.categories = { ok: count > 0, detail: `${count} categories` }
  } catch (err) {
    checks.categories = {
      ok: false,
      detail: err instanceof PantaError ? `${err.code}` : String(err),
    }
  }

  checks.database = dbStatsPlaceholder()

  const breaker = breakerState('panta')
  const healthy = Object.values(checks).every((c) => c.ok)

  return NextResponse.json(
    {
      ok: healthy,
      canCreateMarkets,
      checks,
      rate: limiterSnapshot(),
      breaker: breaker.state,
      breakerError: breaker.lastError ?? null,
      cache: cacheStats(),
      rpc: redactRpcUrl(),
      // Never the key itself.
      pantaKeyPresent: Boolean(process.env.PANTA_API_KEY),
    },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
