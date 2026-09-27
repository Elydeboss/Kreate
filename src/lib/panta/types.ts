/**
 * TypeScript shapes for the Panta API responses Pulse depends on.
 *
 * These are written against the documented contract, not against captured
 * payloads. Two known traps are encoded here rather than left to the caller:
 *
 *   1. AMOUNT FORMATS DIFFER BY SURFACE. Market creation takes USDC base units
 *      as an integer string ("50000000" = 50 USDC). Primary buys take a human
 *      decimal string ("20.00"). Mixing them is a silent 1000000x error, so the
 *      two are separate branded types, not `string`.
 *
 *   2. THE TWO BUILD RESPONSES ARE DIFFERENT SHAPES. Create returns a
 *      pre-assembled base64 VersionedTransaction. Buy and claim return raw
 *      instructions[] that the caller must compile. See lib/tx/.
 *
 * Nothing here is a source of truth. Panta and the chain are. See
 * ARCHITECTURE.md §4.1.
 */

// ── Branded string types: prevent mixing amount formats ─────────────────────

/** USDC base units, integer string. 6 decimals. `"50000000"` === 50 USDC. */
export type UsdcBaseUnits = string & { readonly __brand: 'UsdcBaseUnits' }

/** Human-readable decimal USDC, e.g. `"20.00"`. Used by primary buys. */
export type UsdcDecimal = string & { readonly __brand: 'UsdcDecimal' }

export const usdcBaseUnits = (s: string): UsdcBaseUnits => s as UsdcBaseUnits
export const usdcDecimal = (s: string): UsdcDecimal => s as UsdcDecimal

/** USDC -> base units. 6 decimals. Throws on anything that is not a plain number. */
export function toBaseUnits(amount: number | string): UsdcBaseUnits {
  const n = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(n)) throw new TypeError(`Invalid USDC amount: ${String(amount)}`)
  if (n < 0) throw new RangeError('USDC amount must be non-negative')
  return Math.round(n * 1_000_000).toString() as UsdcBaseUnits
}

/** Base units -> human decimal string. */
export function fromBaseUnits(base: string): UsdcDecimal {
  const n = Number(base)
  if (!Number.isFinite(n)) throw new TypeError(`Invalid base-unit amount: ${base}`)
  return (n / 1_000_000).toFixed(2) as UsdcDecimal
}

// ── Shared primitives ───────────────────────────────────────────────────────

/** Public categories allowed by Panta. GET /categories/ is the source. */
export const PANTA_CATEGORIES = [
  'sports',
  'crypto',
  'politics',
  'entertainment',
  'finance',
  'science',
  'world',
  'other',
] as const
export type PantaCategory = (typeof PANTA_CATEGORIES)[number]

/** A base58 Solana address. */
export type SolanaAddress = string

export type MarketType = 'standard' | 'breaking'
export type MarketPhase = 'primary' | 'secondary' | 'resolved' | 'cancelled'
export type MarketOutcome = 'yes' | 'no'
export type OrderSide = 'yes' | 'no'

/** One compiled instruction, as returned by buy/claim `build`. */
export interface PantaInstruction {
  programId: string
  accounts: Array<{
    pubkey: string
    isSigner: boolean
    isWritable: boolean
  }>
  /** base64-encoded instruction data */
  data: string
}

/** Envelope shared by the `build` responses that return raw instructions. */
export interface InstructionBuild {
  instructions: PantaInstruction[]
  recentBlockhash: string
  lastValidBlockHeight: number
}

// ── Account ─────────────────────────────────────────────────────────────────

/** GET /account/ */
export interface PantaAccount {
  id: string
  email?: string
  name?: string
  /** Must be true before Pulse can create markets. Verify on day 1. */
  canCreateMarkets: boolean
  environment?: string
}

/** GET /account/metrics/ — the receipts behind the "Pulse on Panta" stats page. */
export interface PantaAccountMetrics {
  summary: {
    creates: number
    trades: {
      volumeUsdcBase: string
      count: number
    }
  }
  keys?: Array<Record<string, unknown>>
}

/** GET /account/trades/ */
export interface PantaAccountTrade {
  signature: string
  userId?: string
  kind?: 'buy' | 'claim'
  amountUsdc?: string
  blockTime?: number
  marketId?: string
}

/** GET /account/creates/ */
export interface PantaAccountCreate {
  marketId: string
  question: string
  title?: string
  createdAt?: string
  blockTime?: number
}

// ── Markets ─────────────────────────────────────────────────────────────────

/**
 * Row shape from GET /markets/.
 *
 * ⚠ yesPrice / noPrice are NULL on list responses. Panta does not live-RPC
 * prices for list. GET /markets/{id}/ is the only live-price endpoint. Never
 * render a price from a list row.
 *
 * ⚠ createdBy=me filters by Panta API ACCOUNT, not by your Pulse user. It
 * returns every market this key created. Per-user ownership lives in Postgres.
 */
export interface PantaMarketListItem {
  marketId: string
  question: string
  title: string
  category: PantaCategory
  imageUrl: string
  phase: MarketPhase
  marketType: MarketType
  yesPrice: number | null
  noPrice: number | null
  resolved: boolean
  outcome: MarketOutcome | null
  volumeUsdcBase?: string
  startTime: number
  endTime: number
  resolutionTime: number
  createdAt?: string
}

/** GET /markets/{id}/ — the live-price source. */
export interface PantaMarketDetail extends PantaMarketListItem {
  yesPrice: number
  noPrice: number
  resolutionRule?: string
  sourcesOfTruth?: string[]
  createdBy?: string
}

/** A real trade from GET /markets/{id}/trades/. Never synthesised. */
export interface PantaTrade {
  signature: string
  wallet: SolanaAddress
  /** USDC amounts per side. A buy puts the value on exactly one side. */
  yesAmount: string
  noAmount: string
  feePaid?: string
  /** Unix seconds. */
  blockTime: number | null
  quoteAsset?: string
  /** Derive: yesAmount > 0 ? 'yes' : noAmount > 0 ? 'no' : null */
  side: OrderSide | null
  /** shares = yesAmount + noAmount, for the leading side */
  shares: string
}

// ── Create market ───────────────────────────────────────────────────────────

/**
 * POST /markets/create/quote/
 *
 * ⚠ THE FEE IS NOT AN INPUT. There is no `paymentUsdc` in this body. Panta
 * quotes the creation fee and returns it; the client cannot choose or cap it.
 * This is the single most important correction from the published examples,
 * which show `paymentUsdc` on the RESPONSE and invite you to copy it sideways.
 * Pulse therefore cannot budget markets from a hardcoded figure — the quote is
 * the budget line, and the first call in rehearsal is the one that tells us what
 * a market actually costs. See ARCHITECTURE.md §3.3.
 */
export interface CreateQuoteRequest {
  /** The wallet that will sign. Required — Panta derives the event PDA from it. */
  wallet: SolanaAddress
  question: string
  title: string
  category: PantaCategory
  /** Required by Panta. Public HTTP(S), catalog-hosted, 1024x1024 recommended. */
  imageUrl: string
  marketType: MarketType
  /**
   * MUST be true for every Live Mode market. Without it, startTime is required
   * to be at least minimumStartDelay (typically 3600s) ahead of now, which makes
   * a mid-match market impossible.
   *
   * With it, Panta inverts the constraint and requires startTime <= now <= endTime.
   * Panta rejects the inverse case too: a `breaking` market with eventInProgress
   * off must have a FUTURE startTime. Both directions are validated server-side
   * in marketCreate.ts. See ARCHITECTURE.md §3.4.
   */
  eventInProgress: boolean
  resolutionRule: string
  sourcesOfTruth: string[]
  /** Unix seconds. */
  startTime: number
  endTime: number
  resolutionTime: number
  /** Free text. Defaults to "Global"; Panta accepts it. */
  region?: string
  description?: string
  /** Panta's resolver. Omit and Panta uses its default oracle. */
  oracle?: string
  /** Pulse user id, for Panta-side attribution. */
  userId: string
}

export interface CreateQuoteResponse {
  /** TTL ~5 minutes. */
  createId: string
  /** The real market-creation fee, in base units. The actual budget line. */
  paymentUsdc: string
  /** PDA the market will land at. Known before signing — useful for the tape. */
  expectedEventPda: string
  /** What the fee buys: liquidity injected into the pool. */
  liquidityInjectionUsdc?: string
  /** Panta's cut of the same. */
  platformRevenueUsdc?: string
  marketType: string
  expiresAt: string
  /**
   * How much life the createId's blockhash has left. Panta telling us its own
   * deadline is worth more than our 60s assumption, and this is the number to
   * show a user whose wallet popup is taking too long.
   */
  blockhashExpiryHintSec?: number
}

/**
 * POST /markets/create/build/
 *
 * TRANSACTION SHAPE A — a pre-assembled unsigned VersionedTransaction, base64.
 * Deserialize, sign, broadcast. Do NOT treat this as instructions[]; that is
 * shape B and the two are not interchangeable.
 */
export interface CreateBuildRequest {
  createId: string
  /** The same wallet that was quoted. Panta checks it against the createId. */
  wallet: SolanaAddress
  userId: string
}

export interface CreateBuildResponse {
  createId: string
  expectedEventPda: string
  /** Base64, pre-assembled, UNSIGNED. Shape A. */
  transaction: string
  recentBlockhash: string
  lastValidBlockHeight?: number
  /** The fee this build will charge. Compare against the quote to catch a change. */
  paymentUsdc: string
  marketType: string
  /** Changes if the build is called again with a different blockhash. */
  buildFingerprint?: string
  /** Panta's derived accounts. Useful in a bug report, useless otherwise. */
  derived?: Record<string, string>
  /** ~5 min, matches createId. */
  expiresAt?: string
}

/** POST /markets/register/ — idempotent on (createId, signature). */
export interface RegisterRequest {
  createId: string
  signature: string
}

export interface RegisterResponse {
  createId: string
  /** The Panta market id — an event PDA. This is what buys and claims reference. */
  marketId: string
  status: string
  /** Echoed back. Recorded in our ledger so the tape can resolve it without a call. */
  signature: string
  category?: string
  title?: string
  images?: string[]
}

// ── Primary orders (buy) ────────────────────────────────────────────────────

/** POST /primaryorderquote/ */
export interface OrderQuoteRequest {
  marketId: string
  wallet: SolanaAddress
  side: OrderSide
  /** Human decimal string, NOT base units. */
  amountUsdc: UsdcDecimal
  /** Defaults server-side to 100 (1%). */
  maxSlippageBps?: number
  /** Pulse user id, for attribution. */
  userId: string
}

export interface OrderQuoteResponse {
  /** TTL ~90 seconds. */
  quoteId: string
  marketId: string
  side: OrderSide
  amountUsdc: string
  shares: string
  /**
   * A DECIMAL STRING, not a number. Panta returns `"0.63"` here while
   * `/markets/{id}/` returns yesPrice as a JSON number. Converting this one
   * eagerly to a float is how a price renders as 0.6299999999999999 in the UI.
   * Keep the string until it is formatted for a human.
   */
  avgPrice: string
  feeUsdc: string
  expiresAt: string
}

/**
 * POST /primaryorderbuild/
 *
 * TRANSACTION SHAPE B — raw instructions. You compile the message yourself.
 * TTL ~120s. Blockhash is valid ~60s, which is the tightest constraint in the
 * whole product. See ARCHITECTURE.md §3.2.
 *
 * ⚠ THE INPUT IS `quoteId`, NOT `orderId`. The orderId is minted BY this call
 * and comes back in the response. Passing an orderId here is a 400, and it is
 * an easy mistake because the response is the thing that has the orderId in it.
 */
export interface OrderBuildRequest {
  quoteId: string
  /** The buyer. Must match the wallet that was quoted. */
  wallet: SolanaAddress
  /** Defaults server-side to 100 (1%). */
  maxSlippageBps?: number
  userId: string
}

export interface OrderBuildResponse extends InstructionBuild {
  /** Minted by this call. It is the handle for submit and verify. */
  orderId: string
  quoteId: string
  wallet: SolanaAddress
  marketId: string
  side: OrderSide
  amountUsdc: string
  /** What you get if the order fills exactly. Slippage is measured against this. */
  expectedShares: string
  feeUsdc: string
  status: string
}

/**
 * POST /primaryordersubmit/ — idempotent on (orderId, signature).
 *
 * `wallet` is required. Without it Panta cannot tie the signature to the buyer
 * and the submit is rejected, which reads as a mysteriously failed order rather
 * than a missing field.
 */
export interface OrderSubmitRequest {
  orderId: string
  signature: string
  wallet: SolanaAddress
}

export interface OrderSubmitResponse {
  orderId: string
  status: string
}

/**
 * POST /primaryorderverify/
 *
 * `signature` and `wallet` are both accepted. Omitting a signature is how you
 * ask "is this order ok so far", which is the right question after a build and
 * before the wallet popup returns.
 */
export interface OrderVerifyRequest {
  orderId: string
  signature?: string
  wallet?: SolanaAddress
}

export type OrderVerifyStatus = 'built' | 'submitted' | 'confirmed' | 'failed'

export interface OrderVerifyResponse {
  orderId: string
  status: OrderVerifyStatus
  signature?: string
  error?: string
}

// ── Positions and claims ────────────────────────────────────────────────────

/**
 * GET /positions/ — wallet-scoped and SHARE-denominated, not USD.
 *
 * ⚠ Two rows for the same market (one per side) is expected, not a bug.
 * ⚠ Capped around 200 rows and can lag the chain right after a buy. Do not
 *   persist this; read live, cache ~30s.
 *
 * USD value is computed in the client: shares x side price while open;
 * shares x 1 if side === outcome after resolution, else 0.
 */
export interface PantaPosition {
  marketId: string
  side: OrderSide
  shares: string
  claimable: boolean
  claimed: boolean
  outcome: MarketOutcome | null
  phase: MarketPhase
  marketTitle?: string
  marketQuestion?: string
  marketYesPrice?: number | null
  marketNoPrice?: number | null
}

/** POST /claim/build/ — TRANSACTION SHAPE B, same shape as OrderBuildResponse. */
export interface ClaimBuildResponse extends InstructionBuild {
  outcome: MarketOutcome
  winningShares: string
}

// ── Trade reporting (attribution) ───────────────────────────────────────────

/**
 * POST /trades/ — reports a buy or a win claim for Panta-side attribution.
 *
 * Idempotent on `signature`, so retry freely.
 *
 * ⚠ Do NOT report creator-fee claims here. They return TX_MISMATCH by design —
 * creator fees are not part of the reported trade set, and they are not even
 * reachable without a graduated market. See PRD §6.
 */
export interface ReportTradeRequest {
  signature: string
  /** Required. Panta ties the signature to the trader with it. */
  wallet: SolanaAddress
  /** Required, and it is the Panta market id (event PDA), not ours. */
  marketId: string
  /** The quote this order was built from, if we kept it. */
  quoteId?: string
  /** Our orderId. Panta echoes it for reconciliation. */
  clientOrderId?: string
  /** Pulse user id, for attribution. */
  userId?: string
  /**
   * Panta infers this from the transaction. Send it only for a claim, where
   * there is no orderId to infer from.
   */
  kind?: 'buy' | 'claim'
}

/**
 * POST /trades/ — attribution. Idempotent on signature, so retry freely.
 *
 * Note there is NO submit counterpart for claims: the claim is complete the
 * moment the transaction confirms. `/trades/` is purely a receipt to Panta.
 */
export interface ReportTradeResponse {
  signature: string
  status: string
  marketId?: string
  wallet?: string
  side?: string
  kind?: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive which side a Panta trade landed on. */
export function tradeSide(yesAmount: string, noAmount: string): OrderSide | null {
  const yes = Number(yesAmount)
  const no = Number(noAmount)
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return null
  if (yes > 0 && no === 0) return 'yes'
  if (no > 0 && yes === 0) return 'no'
  return null
}

/** USD value of a position, given the market's prices and outcome. */
export function positionValueUsdc(
  shares: string,
  side: OrderSide,
  market: { yesPrice?: number | null; noPrice?: number | null; resolved: boolean; outcome: MarketOutcome | null } | undefined,
): number {
  const n = Number(shares)
  if (!Number.isFinite(n) || !market) return 0
  if (market.resolved) {
    return market.outcome === side ? n : 0
  }
  const price = side === 'yes' ? market.yesPrice : market.noPrice
  return typeof price === 'number' ? n * price : 0
}
