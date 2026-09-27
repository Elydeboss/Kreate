import 'server-only'

/**
 * Primary buy: quote -> build -> [client signs] -> submit + attribute.
 *
 * The same shape as `marketCreate.ts` and for the same reasons, with one extra
 * wrinkle: the QUOTE IS THE THING THAT GOES STALE.
 *
 *   1. Quote Panta. Get `quoteId`, shares, average price, fee.   (~90s TTL)
 *   2. Build Panta with that quoteId. Get an orderId and         (~120s TTL,
 *      raw instructions. A blockhash good for ~60s.  <-- the pinch)
 *   3. ......... client signs and broadcasts; server uninvolved .........
 *   4. Client POSTs the signature. Submit to Panta, report the trade
 *      for attribution, append an event.
 *
 * WHY THE ORDER IS SPLIT ACROSS TWO USER ACTIONS. The blockhash Panta hands back
 * in step 2 lives ~60 seconds, and between step 2 and the broadcast sits a phone
 * unlocking, a wallet app launching, and a person reading a slippage number. On a
 * mid-range Android over café wifi that is genuinely marginal. So we quote when
 * the buy sheet opens — the user sees a real price and a real share count while
 * they are still deciding — and we build only when they press confirm, and we
 * hand them a transaction that is as fresh as the one second it was minted.
 * Building at quote time would hand them a transaction that is already dead by the
 * time they say yes. See ARCHITECTURE.md §3.5.
 *
 * WHY `requireOrder` EXISTS. A buy is the one flow where the user is spending
 * their own money out of their own wallet, and the id that authorises it arrives
 * in a response body. A signed request to /build that carries someone else's
 * orderId would happily build someone else's order. So every step re-derives
 * ownership from the ledger rather than trusting the client. The X-Pulse-Wallet
 * header is forgeable; that is survivable everywhere else because nothing that
 * moves money trusts it. Here it must not.
 *
 * ⚠ ASYMMETRY THAT WILL BITE: `amountUsdc` here is a HUMAN DECIMAL ("20.00"),
 * while the create fee is BASE UNITS ("20000000"). They are branded as separate
 * types so the two cannot be confused. See ARCHITECTURE.md §3.3.
 */

import { panta } from '@/lib/panta/client'
import { PantaError, buyErrorMessage } from '@/lib/panta/errors'
import { usdcDecimal, type PantaInstruction, type OrderSide, type SolanaAddress, type UsdcDecimal } from '@/lib/panta/types'
import { findMarketById, findMarketByPantaId } from '@/lib/db/queries/markets'
import { recordOrder, markOrderSubmitted, markOrderStatus, findOrder } from '@/lib/db/queries/pantaFlows'
import { appendEvent } from '@/lib/db/queries/events'
import { isMember } from '@/lib/db/queries/circles'
import { requireSessionId } from './guards'
import { ValidationError, ConflictError } from './validation'
import type { User } from '@/lib/db/queries/users'

/**
 * Smallest buy we will let through. Below this, gas and the fixed part of
 * Panta's fee dominate and the user gets shares that round to nothing.
 */
const MIN_BUY_USDC = 1

/**
 * Largest single buy.
 *
 * This is not a policy decision we are entitled to make for a user with their own
 * money — it is a guard against a fat-fingered amount becoming an unrecoverable
 * one. Panta will happily quote 10,000 USDC and the user will not have meant it.
 */
const MAX_BUY_USDC = 500

/** Panta's default, 100 bps. Stated here so the UI and the request agree. */
export const DEFAULT_SLIPPAGE_BPS = 100

export class BuyValidationError extends ValidationError {
  readonly side: OrderSide | null
  constructor(message: string, side: OrderSide | null = null) {
    super(message)
    this.name = 'BuyValidationError'
    this.side = side
  }
}

/** The market cannot be bought at all, for a state reason the user can be told. */
export class MarketNotTradableError extends ConflictError {
  constructor(message: string, code = 'MARKET_NOT_TRADABLE') {
    super(message, code)
    this.name = 'MarketNotTradableError'
  }
}

export interface BuyIntent {
  circleId: string
  /** Our market id, not Panta's. The client only ever knows ours. */
  pulseMarketId: string
  side: OrderSide
  /** A human decimal, as typed. Validated, then normalised to 2dp. */
  amountUsdc: string
  maxSlippageBps?: number
}

export interface BuyQuoteResult {
  pulseMarketId: string
  quoteId: string
  shares: string
  /** A decimal STRING, kept as Panta sent it. See OrderQuoteResponse. */
  avgPrice: string
  feeUsdc: string
  expiresAt: string
  /** What the same money buys at the other side, for the "vs" line in the UI. */
  notionalNote?: string
}

/**
 * Step 1: quote.
 *
 * The user sees this while they are still deciding, so it is the cheapest place
 * to find out that the market has closed, the amount is too small, or the price
 * has run away. Catching it here costs a quote; catching it at build costs the
 * user's attention and a failed tap.
 */
export async function quoteBuy(
  intent: BuyIntent,
  user: User,
): Promise<BuyQuoteResult> {
  const market = await tradableMarket(intent.pulseMarketId, intent.circleId, user)
  const side = intent.side
  const amount = normaliseAmount(intent.amountUsdc, side)

  const { value: quote } = await panta.primaryOrderQuote({
    // Panta's id, from our row. Never accept the client's word for this.
    marketId: market.pantaMarketId!,
    wallet: user.wallet as SolanaAddress,
    side,
    amountUsdc: amount,
    maxSlippageBps: clampSlippage(intent.maxSlippageBps),
    // Attribution. Also sent on build, because a quote that is never built still
    // shows up in Panta's /account/trades/ as an intent.
    userId: user.id,
  })

  return {
    pulseMarketId: market.id,
    quoteId: quote.quoteId,
    shares: quote.shares,
    avgPrice: quote.avgPrice,
    feeUsdc: quote.feeUsdc,
    expiresAt: quote.expiresAt,
  }
}

export interface BuyBuildResult {
  orderId: string
  quoteId: string
  /**
   * TRANSACTION SHAPE B. Raw instructions plus a blockhash — the client compiles
   * the message itself. This is NOT the pre-assembled transaction that a create
   * returns, and treating the two alike is the single most expensive bug in this
   * file's family. See `src/lib/tx/instructionTx.ts`.
   */
  instructions: PantaInstruction[]
  recentBlockhash: string
  lastValidBlockHeight: number | null
  /** For the slippage line in the wallet sheet. */
  expectedShares: string
  amountUsdc: string
  side: OrderSide
  /**
   * True when the quote had gone stale and we silently re-quoted once. The UI
   * shows the user the NEW price and says so, because a price they did not agree
   * to is the whole reason QUOTE_STALE exists.
   */
  requoted: boolean
  /** The price this build is actually priced at, which may differ from the quote. */
  avgPrice?: string
  feeUsdc?: string
}

export interface BuyBuildInput {
  pulseMarketId: string
  circleId: string
  quoteId: string
  user: User
  maxSlippageBps?: number
  /**
   * The original intent, so a stale quote can be replaced without a second user
   * action.
   *
   * This is the reason a stale quote is not a dead end. The alternative is
   * telling the user "the price moved, tap again", which on a 60-second blockhash
   * means a second round trip through a wallet popup — and a second chance for
   * them to change their mind or run out of time. Re-quoting server-side keeps
   * the whole retry inside one tap. See ARCHITECTURE.md §3.5.
   */
  requote?: { side: OrderSide; amountUsdc: UsdcDecimal }
}

/**
 * Step 2: build, with exactly one silent re-quote.
 *
 * The re-quote is deliberately capped at one. An auto-retry loop against a moving
 * price is how you fill someone at a price they never saw, and it burns the
 * quote rate limit (30/min) besides. If the second quote also goes stale between
 * the two calls, the user gets the real error and decides what to do.
 */
export async function buildBuy(input: BuyBuildInput): Promise<BuyBuildResult> {
  const wallet = input.user.wallet as SolanaAddress
  const slippage = clampSlippage(input.maxSlippageBps)

  try {
    const built = await buildOnce(input.quoteId, wallet, input.user.id, slippage)
    return { ...built, requoted: false }
  } catch (err) {
    const stale = err instanceof PantaError && err.reQuote
    if (!stale || !input.requote) throw err

    // ⚠ Re-run the amount through the SAME validation as the first quote. The
    // requote material arrives from the client alongside the quoteId, and a path
    // that skips the min/max check is a path where a value rejected moments ago
    // goes through — which is how a 0.50 USDC buy becomes a real one the moment
    // the price moves.
    const side = input.requote.side
    const amount = normaliseAmount(input.requote.amountUsdc, side)

    const { value: quote } = await panta.primaryOrderQuote({
      marketId: await pantaMarketIdFor(input.pulseMarketId, input.circleId, input.user),
      wallet,
      side,
      amountUsdc: amount,
      maxSlippageBps: slippage,
      userId: input.user.id,
    })
    const rebuilt = await buildOnce(quote.quoteId, wallet, input.user.id, slippage)

    return {
      ...rebuilt,
      requoted: true,
      // The user must see the price they are actually agreeing to.
      avgPrice: quote.avgPrice,
      feeUsdc: quote.feeUsdc,
    }
  }
}

async function buildOnce(
  quoteId: string,
  wallet: SolanaAddress,
  userId: string,
  maxSlippageBps: number,
): Promise<Omit<BuyBuildResult, 'requoted'>> {
  // ⚠ A QUOTE ID goes in here. The orderId comes OUT of this call. Sending the
  // orderId is a 400 that reads like a server fault, because every other
  // step in this flow is keyed by the orderId and the asymmetry is invisible.
  const { value: build } = await panta.primaryOrderBuild({
    quoteId,
    wallet,
    maxSlippageBps,
    userId,
  })

  // Record the order BEFORE the user has signed anything.
  //
  // Same reasoning as the create flow, and the same reason it matters more here:
  // an order row with status `built` and no signature is the evidence that lets
  // `listUnsettledOrdersForMarket` find a transaction that was handed to a wallet
  // and never came back. Without it, a user whose wallet silently dropped the
  // transaction leaves a position nobody can explain.
  await recordOrder({
    orderId: build.orderId,
    quoteId: build.quoteId,
    pulseMarketId: await pulseMarketIdForOrder(build.marketId),
    wallet,
    side: build.side,
    // The amount as Panta echoes it, not as we asked for it. If these differ,
    // this record is what will show it.
    amountUsdc: build.amountUsdc,
    userId,
  })

  return {
    orderId: build.orderId,
    quoteId: build.quoteId,
    instructions: build.instructions,
    recentBlockhash: build.recentBlockhash,
    lastValidBlockHeight: build.lastValidBlockHeight ?? null,
    expectedShares: build.expectedShares,
    amountUsdc: build.amountUsdc,
    side: build.side,
  }
}

export interface BuySubmitResult {
  orderId: string
  status: string
  /** False when Panta's /trades/ call failed. The buy still happened. */
  attributed: boolean
}

/**
 * Step 4: the signature came back.
 *
 * Three separate things happen here and they are deliberately not one atomic
 * step, because they can each fail independently and only the first is fatal:
 *
 *   1. `/primaryordersubmit/` — tells Panta the order was filled. Idempotent on
 *      (orderId, signature). If this fails the user has still got their shares;
 *      the order is real on chain and Panta will reconcile it.
 *   2. `/trades/` — attribution, so Panta's own dashboard shows Pulse's volume
 *      and this Pulse user is credited. Idempotent on signature. This is a
 *      RECEIPT, not a submission: failing it loses us a number on a dashboard,
 *      nothing else. So it is reported, not thrown.
 *   3. The local event, which is what the room's tape and scoreboard read.
 *
 * Order matters: local state is written even if attribution fails, because the
 * trade happened either way and the tape is the one thing we can be certain of.
 */
export async function submitBuy(
  orderId: string,
  signature: string,
  user: User,
): Promise<BuySubmitResult> {
  const order = await requireOwnedOrder(orderId, user.wallet)

  // The order row carries only our market id. Everything else — Panta's id, the
  // circle, the session — is on the market, and it is read once here so the three
  // facts below cannot disagree with each other.
  const market = await findMarketById(order.pulseMarketId)
  if (!market || !market.pantaMarketId) {
    // The market row vanished or was never registered, yet an order was built
    // against it. Not recoverable, and not something to attribute against a
    // market id we would have to invent.
    throw new MarketNotTradableError('The market for that order is missing.', 'UNKNOWN_MARKET')
  }

  const submitted = await panta
    .primaryOrderSubmit({ orderId, signature, wallet: user.wallet as SolanaAddress })
    .then((r) => r.value)
    .catch((err: unknown) => {
      // Re-read before giving up. The signature may well have arrived on a first
      // attempt whose response was lost, and reporting failure for a buy that
      // actually filled is the one outcome worse than a slow response.
      if (order.signature === signature) return { orderId, status: 'submitted' }
      throw err
    })

  const settled = (await markOrderSubmitted(orderId, signature)) ?? order

  // Attribution. Never fatal.
  const attributed = await panta
    .reportTrade({
      signature,
      wallet: user.wallet as SolanaAddress,
      marketId: market.pantaMarketId,
      quoteId: settled.quoteId ?? undefined,
      // Panta's namespace for "the id you gave this order". Echoed back on their
      // trade list, which is how a disputed trade gets traced to our ledger.
      clientOrderId: orderId,
      userId: user.id,
    })
    .then(() => true)
    .catch((err: unknown) => {
      console.error('[buy] trade attribution failed', { orderId, err })
      return false
    })

  await appendEvent({
    sessionId: requireSessionId(market.sessionId, `order ${orderId}`),
    type: 'trade.reported',
    actorUserId: user.id,
    marketId: order.pulseMarketId,
    payload: {
      // TradeEventPayload. `side` and `amountUsdc` are what the tape renders; the
      // signature is what makes it clickable to the chain.
      signature,
      side: settled.side,
      amountUsdc: settled.amountUsdc,
      orderId,
      kind: 'buy',
    },
  })

  return { orderId, status: submitted.status ?? 'submitted', attributed }
}

/**
 * Give up on an order the user never signed.
 *
 * Marked `expired`, not deleted. A transaction that was handed to a wallet and
 * may or may not have landed is precisely the state that must stay answerable.
 */
export async function abandonOrder(orderId: string, wallet: string, reason: string): Promise<void> {
  const order = await findOrder(orderId)
  if (!order || order.wallet !== wallet) return
  if (order.status === 'submitted' || order.status === 'confirmed') return
  await markOrderStatus(orderId, 'expired')
  console.warn(`[buy] ${orderId} abandoned: ${reason}`)
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Load a market and prove it is buyable by this user, right now.
 *
 * Every gate is a real state a market can be in, and each one has its own copy
 * because "you can't buy this" with no reason is the most frustrating thing an
 * app can say during a live event.
 */
async function tradableMarket(pulseMarketId: string, circleId: string, user: User) {
  if (!(await isMember(circleId, user.id))) {
    throw new BuyValidationError('You are not in this circle.')
  }

  const market = await findMarketById(pulseMarketId)
  if (!market || market.circleId !== circleId) {
    throw new BuyValidationError('That market does not exist.')
  }
  if (!market.pantaMarketId) {
    // The create was quoted but never registered — the signature did not arrive,
    // or Panta rejected it. Showing a buy button here would promise a trade that
    // cannot happen.
    throw new MarketNotTradableError('This market is still being set up.', 'NOT_REGISTERED')
  }
  if (market.resolved) {
    throw new MarketNotTradableError('This market has already resolved.', 'RESOLVED')
  }
  if (market.phase && market.phase !== 'primary') {
    throw new MarketNotTradableError('This market is not taking new positions.', 'NOT_PRIMARY')
  }
  if (market.endTime <= Math.floor(Date.now() / 1000)) {
    throw new MarketNotTradableError('This market has closed.', 'CLOSED')
  }
  return market
}

async function pantaMarketIdFor(
  pulseMarketId: string,
  circleId: string,
  user: User,
): Promise<string> {
  const market = await tradableMarket(pulseMarketId, circleId, user)
  return market.pantaMarketId!
}

/**
 * Resolve a Panta market id back to our market id.
 *
 * The reverse direction from `pantaMarketIdFor`, needed because the build response
 * is keyed by Panta's id and the ledger by ours. A miss here means the build
 * belongs to a market we do not have, which is not something to paper over.
 */
async function pulseMarketIdForOrder(pantaMarketId: string): Promise<string> {
  const market = await findMarketByPantaId(pantaMarketId)
  if (!market) {
    throw new MarketNotTradableError('That order is for an unknown market.', 'UNKNOWN_MARKET')
  }
  return market.id
}

/**
 * Prove this order belongs to this wallet.
 *
 * The orderId arrives from the client in a signed request. Without this, anyone
 * could ask us to build or submit an order id they guessed, and the wallet
 * parameter we pass to Panta would be ours rather than theirs. The header is
 * forgeable; this check is what stops the forgery reaching anything.
 */
async function requireOwnedOrder(orderId: string, wallet: string) {
  const order = await findOrder(orderId)
  if (!order) {
    throw new BuyValidationError('That order is not a known Pulse order.')
  }
  if (order.wallet !== wallet) {
    // Deliberately vague about which half was wrong. Saying "that order is not
    // yours" confirms the order exists, which is a small leak for no real gain.
    throw new BuyValidationError('That order is not yours to submit.')
  }
  return order
}

/**
 * Validate a buy amount and normalise it to two decimal places.
 *
 * Normalising matters: Panta stores `amount_usdc` as a decimal string and a
 * 20.005 that we pass through verbatim becomes a ledger entry that will never
 * match a tape row. Two dp is USDC's actual precision, so this loses nothing.
 */
function normaliseAmount(raw: string, side: OrderSide): UsdcDecimal {
  const trimmed = String(raw ?? '').trim().replace(/[$,\s]/g, '')
  if (trimmed.length === 0) {
    throw new BuyValidationError('Enter an amount.', side)
  }
  if (!/^\d*\.?\d*$/.test(trimmed)) {
    throw new BuyValidationError('That is not an amount.', side)
  }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) {
    throw new BuyValidationError('That is not an amount.', side)
  }
  if (n < MIN_BUY_USDC) {
    throw new BuyValidationError(`The minimum is ${MIN_BUY_USDC} USDC.`, side)
  }
  if (n > MAX_BUY_USDC) {
    throw new BuyValidationError(`The maximum in one go is ${MAX_BUY_USDC} USDC.`, side)
  }
  return usdcDecimal(n.toFixed(2))
}

/**
 * Clamp slippage into something a human meant.
 *
 * Below 50bps a live market rejects almost every fill, which looks like the app
 * being broken. Above 1000bps the user is authorising a 10% loss in one tap. Both
 * bounds are enforced rather than trusted, and both are surfaced in the UI so the
 * clamp is never silent.
 */
function clampSlippage(bps: number | undefined): number {
  if (bps === undefined || !Number.isFinite(bps)) return DEFAULT_SLIPPAGE_BPS
  return Math.min(1000, Math.max(50, Math.round(bps)))
}

export { buyErrorMessage, MIN_BUY_USDC, MAX_BUY_USDC }
