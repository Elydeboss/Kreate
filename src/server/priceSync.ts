import 'server-only'

/**
 * Price refresh for the markets in a live room.
 *
 * ⚠ THE RATE BUDGET IS SHARED BY EVERY USER ON THE API KEY. Panta allows 120
 * reads per 60s per key, not per user. A room with 8 markets polled every 2
 * seconds by 5 people is 1,200 upstream calls a minute against a budget of 120,
 * and the limiter will start refusing — not because Pulse is misbehaving, but
 * because N markets x M users is a quadratic shape and a linear budget.
 *
 * Two things stop it, and the second is the important one:
 *
 *   1. The TTL cache in lib/panta/cache is process-local, so every user polling
 *      the same market inside one TTL window collapses into ONE upstream call.
 *      Ten people in one room cost the same as one. This is why the app is worth
 *      deploying as one instance and why the cache must never be moved behind a
 *      shared store with different semantics.
 *
 *   2. The price TTL is DERIVED from the market count rather than chosen by
 *      hand, below. More markets in the room automatically means a longer
 *      staleness window, which is the correct thing to trade: a 17-second-old
 *      price in a room with 20 markets beats a rate-limit wall where no price
 *      updates at all.
 *
 * THE CONSEQUENCE, STATED PLAINLY: a room gets less live the more markets it
 * holds. That is not a bug to be engineered away, it is the shape of a shared
 * per-key budget. Product answer, not an engineering one: Live Mode sessions
 * should hold a handful of markets, not dozens. See ARCHITECTURE.md §7.2.
 */

import { FAMILY_LIMITS } from '@/lib/panta/limiter'
import { breakerState } from '@/lib/panta/breaker'
import { panta } from '@/lib/panta/client'
import { listSessionMarkets, updatePriceSnapshot, type SessionMarket } from '@/lib/db/queries/markets'
import { appendEvent } from '@/lib/db/queries/events'
import { syncMarketTape } from '@/lib/db/queries/trades'
import type { PantaTrade } from '@/lib/panta/types'

/** The one breaker for the whole Panta surface. */
export const BREAKER_NAME = 'panta'

/**
 * Fraction of the read budget we are willing to spend on price refreshes.
 *
 * The remainder pays for everything else: the tape, positions, account metrics,
 * and the ops page. 0.6 leaves real headroom, because a room that spends the last
 * read on a price has nothing left to spend on the trade that moved it.
 */
const BUDGET_FRACTION = 0.6

/** Never poll faster than this, whatever the arithmetic says. */
const MIN_TTL_MS = 2_000

/** Never let a single request fire a burst of upstream calls. */
const MAX_REFRESH_PER_REQUEST = 4

/**
 * How stale a snapshot may get before we spend a read on it.
 *
 * Deliberately generous compared to MIN_TTL_MS. The TTL bounds how often we
 * *may* refresh; this bounds how stale we *tolerate*. Tolerating more staleness
 * than the budget strictly allows is what stops a busy room from trying and
 * failing: the limiter refuses, the breaker opens, and then a whole room of
 * prices freezes at once. Quietly 20s behind beats loudly dead.
 */
const STALE_AFTER_MS = 15_000

/**
 * Derive the price TTL from how many markets are live.
 *
 *   markets=1   -> 60/72  = 833ms, floored to 2s
 *   markets=8   -> 60/9   = 6.7s
 *   markets=20  -> 60/3.6 = 16.7s
 *
 * Exported because the ops page should show the number the room is actually
 * running at, not the constant someone remembers reading in this file.
 */
export function priceTtlMs(marketCount: number): number {
  const budgetPerMinute = Math.max(1, Math.floor(FAMILY_LIMITS.read * BUDGET_FRACTION))
  const perMarketPerMinute = budgetPerMinute / Math.max(1, marketCount)
  return Math.max(MIN_TTL_MS, Math.ceil(60_000 / perMarketPerMinute))
}

/**
 * The rate family is not passed in here, and that is deliberate.
 *
 * It is pinned to 'read' inside the client helpers, so a call site cannot spend
 * the tighter 'build' or 'quote' budget on a price read. The rule is enforced one
 * layer down where the endpoint is defined, rather than trusted to twenty call
 * sites to remember.
 */

export interface RefreshReport {
  /** Everything in the room, with whatever prices we currently hold. */
  markets: SessionMarket[]
  /** Markets whose prices we spent a read on this request. */
  refreshed: number
  /** Markets left on their stored snapshot to protect the budget. */
  deferred: number
  /** The TTL the room is currently running at. */
  ttlMs: number
  /** Set when the breaker is open and we are serving stored snapshots. */
  degraded?: string
  /** Trades pulled from Panta's tape for these markets, new ones only. */
  newTrades: number
}

/**
 * Refresh prices for a session's markets, within budget.
 *
 * Order matters twice over, so it is worth reading before changing:
 *
 *   - STALEST FIRST. If the budget only covers 3 of 8 markets, the 3 that get
 *     refreshed are the 3 whose prices are furthest out of date. Refreshing the
 *     freshest 3 would leave a market showing a 60-second-old price indefinitely
 *     while three 2-second-old ones churn.
 *
 *   - BREAKER FIRST. Checked before spending any read. When Panta is down the
 *     right answer is to serve the stored snapshot with a staleness stamp, not
 *     to discover it one 502 at a time.
 */
export async function refreshSessionPrices(sessionId: string): Promise<RefreshReport> {
  const markets = await listSessionMarkets(sessionId)
  if (markets.length === 0) {
    return { markets, refreshed: 0, deferred: 0, ttlMs: priceTtlMs(0), newTrades: 0 }
  }

  const ttlMs = priceTtlMs(markets.length)
  const now = Date.now()

  const breaker = breakerState(BREAKER_NAME)
  if (breaker.state === 'open') {
    // ToU §5 path. Stored prices keep being shown, stamped as stale. No upstream
    // call is attempted, so we do not extend the outage.
    return {
      markets,
      refreshed: 0,
      deferred: markets.length,
      ttlMs,
      degraded: 'Panta is unreachable. Showing the last prices we received.',
      newTrades: 0,
    }
  }

  const stale = markets
    .filter((market) => isStale(market, now, ttlMs))
    .sort((a, b) => snapshotAge(b) - snapshotAge(a))

  const toRefresh = stale.slice(0, MAX_REFRESH_PER_REQUEST)
  const deferred = stale.length - toRefresh.length

  let refreshed = 0
  let newTrades = 0

  for (const market of toRefresh) {
    try {
      // Already cached, single-flighted, breaker-guarded and retry-backing-off
      // inside the client. This call is a request, not a guarantee. The derived
      // TTL is passed down so the cache and the stored snapshot agree about how
      // stale a price is allowed to be — if they disagree, the longer one wins
      // and the budget arithmetic below stops being the real dial.
      const response = await panta.market(market.pantaMarketId, ttlMs)
      const detail = response.value

      await updatePriceSnapshot(market.id, {
        phase: detail.phase,
        resolved: detail.resolved,
        outcome: detail.resolved ? detail.outcome : null,
        yesPrice: detail.yesPrice,
        noPrice: detail.noPrice,
        volumeUsdc: detail.volumeUsdcBase ?? null,
        pricesAsOf: new Date(response.asOf),
      })

      // A market that has just resolved is a real event in the room, and the
      // scoreboard's `correct` / `wrong` columns depend on this row existing.
      if (detail.resolved && !market.resolved && detail.outcome) {
        await appendEvent({
          sessionId,
          type: 'market.resolved',
          marketId: market.id,
          payload: { outcome: detail.outcome, pantaMarketId: market.pantaMarketId },
        })
      }

      newTrades += await syncTape(sessionId, market.id, market.pantaMarketId, ttlMs)
      refreshed += 1
    } catch (err) {
      // One market's failure must not abandon the rest. The client has already
      // counted this against the breaker; here we just move on and let the
      // stored snapshot serve.
      console.error(`[priceSync] ${market.pantaMarketId} refresh failed`, err)
    }
  }

  return { markets, refreshed, deferred, ttlMs, newTrades }
}

/** Is this market's stored snapshot too old to be worth showing? */
function isStale(market: SessionMarket, now: number, ttlMs: number): boolean {
  // A resolved market's price is final. Re-reading it forever is a read spent on
  // a constant, and a room's history is full of them.
  if (market.resolved) return false
  if (!market.pricesAsOf) return true
  return now - market.pricesAsOf.getTime() > Math.max(ttlMs, STALE_AFTER_MS)
}

/** Milliseconds since this market's last successful read. Larger = staler. */
function snapshotAge(market: SessionMarket): number {
  if (!market.pricesAsOf) return Number.MAX_SAFE_INTEGER
  return Date.now() - market.pricesAsOf.getTime()
}

/**
 * Pull a market's tape and fold it into the ledger.
 *
 * Best effort, and separate from the price refresh on purpose. The tape is what
 * makes the room feel alive and what the scoreboard is built from, but a market
 * whose tape call fails must still show its price — the two have different
 * failure modes and coupling them would mean one flaky endpoint blanks a live
 * number.
 */
async function syncTape(
  sessionId: string,
  pulseMarketId: string,
  pantaMarketId: string,
  ttlMs: number,
): Promise<number> {
  try {
    const response = await panta.marketTrades(pantaMarketId, ttlMs)
    const trades = response.value.map((t: PantaTrade) => normalizeTrade(t, pantaMarketId))
    const result = await syncMarketTape(trades, { pulseMarketId, sessionId })
    return result.inserted
  } catch (err) {
    console.error(`[priceSync] tape sync failed for ${pantaMarketId}`, err)
    return 0
  }
}

/**
 * Panta's tape shape to ours.
 *
 * `side` and `shares` are derived here rather than trusted, because Panta's
 * `side` can be null and `shares` is a string.
 *
 * `marketId` is threaded in rather than read off the trade, because Panta's tape
 * rows do not carry one — the endpoint is already scoped to a single market, and
 * a trade synced into the wrong market would be invisible forever. Passing it
 * explicitly means the correlation cannot silently drift.
 *
 * The `side` derivation is duplicated in lib/db/queries/trades.ts on purpose. The
 * two serve different consumers — one builds an API payload, the other scores a
 * ledger row — and sharing a helper would make the query layer depend on the
 * Panta response types for no benefit.
 */
function normalizeTrade(
  trade: PantaTrade,
  pantaMarketId: string,
): {
  signature: string
  pantaMarketId: string
  wallet: string
  yesAmount: number
  noAmount: number
  shares: number
  side: 'yes' | 'no' | null
  feePaid: number | null
  blockTime: number | null
  quoteAsset: string | null
} {
  const yesAmount = Number(trade.yesAmount) || 0
  const noAmount = Number(trade.noAmount) || 0
  return {
    signature: trade.signature,
    pantaMarketId,
    wallet: trade.wallet,
    yesAmount,
    noAmount,
    shares: Number(trade.shares) || 0,
    side: trade.side ?? (yesAmount > 0 ? 'yes' : noAmount > 0 ? 'no' : null),
    feePaid: trade.feePaid ? Number(trade.feePaid) : null,
    blockTime: trade.blockTime,
    quoteAsset: trade.quoteAsset ?? null,
  }
}
