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

/** POST /markets/create/quote/ */
export interface CreateQuoteRequest {
  question: string
  title: string
  category: PantaCategory
  /** Required by Panta. Public HTTP(S), catalog-hosted, 1024x1024 recommended. */
  imageUrl: string
  marketType: MarketType
  /**
   * MUST be true for every Live Mode market. startTime is otherwise required to
   * be at least minimumStartDelay (typically 3600s) ahead of now, which makes a
   * mid-match market impossible. See ARCHITECTURE.md §3.4.
   */
  eventInProgress: boolean
  resolutionRule: string
  sourcesOfTruth: string[]
  startTime: number
  endTime: number
  resolutionTime: number
  /** Base units. */
  paymentUsdc: UsdcBaseUnits
  /** Pulse user id, for Panta-side attribution. */
  userId: string
}

export interface CreateQuoteResponse {
  /** TTL ~5 minutes. */
  createId: string
  /** The real market-creation fee, in base units. The actual budget line. */
  paymentUsdc: string
  expectedEventPda?: string
  expiresAt?: string
}

/**
 * POST /markets/create/build/
 *
 * TRANSACTION SHAPE A — a pre-assembled unsigned VersionedTransaction, base64.
 * Deserialize, sign, broadcast. Do NOT treat this as instructions[]; that is
 * shape B and the two are not interchangeable.
 */
export interface CreateBuildResponse {
  transaction: string
  recentBlockhash?: string
  lastValidBlockHeight: number
  /** ~5 min, matches createId. */
  expiresAt?: string
}

/** POST /markets/register/ — idempotent on (createId, signature). */
export interface RegisterRequest {
  createId: string
  signature: string
}

export interface RegisterResponse {
  marketId: string
  status: string
  expectedEventPda?: string
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
  shares: string
  avgPrice: number
  feeUsdc?: string
  expiresAt?: string
}

/**
 * POST /primaryorderbuild/
 *
 * TRANSACTION SHAPE B — raw instructions. You compile the message yourself.
 * TTL ~120s. Blockhash is valid ~60s, which is the tightest constraint in the
 * whole product. See ARCHITECTURE.md §3.2.
 */
export interface OrderBuildResponse extends InstructionBuild {
  orderId: string
  quoteId: string
  expiresAt?: string
}

/** POST /primaryordersubmit/ — idempotent on (orderId, signature). */
export interface OrderSubmitRequest {
  orderId: string
  signature: string
}

export interface OrderSubmitResponse {
  orderId: string
  status: string
}

/** POST /primaryorderverify/ */
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
  kind: 'buy' | 'claim'
  userId: string
  marketId?: string
}

export interface ReportTradeResponse {
  reported: boolean
  signature: string
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
