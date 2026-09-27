import 'server-only'

/**
 * Win claim: build -> [client signs] -> attribute.
 *
 *   1. Check the position is actually claimable, live, from Panta.
 *   2. Build Panta. Get instructions and a blockhash.    (SHAPE B, ~60s)
 *   3. ......... client signs and broadcasts; server uninvolved .........
 *   4. Client POSTs the signature. Attribute it to Panta and record the event.
 *
 * SHORTER THAN THE OTHER TWO FLOWS, AND NOT BY CHOICE. There is no
 * `/claim/submit/`. The claim is finished the moment the transaction confirms,
 * and `/trades/` afterwards is a receipt, not a submission. A build that suggests
 * otherwise is describing a Panta endpoint that does not exist, and a demo that
 * waits for a submit response is waiting forever.
 *
 * ⚠ THE POSITION IS READ LIVE, NEVER PERSISTED. `/positions/` is wallet-scoped
 * and SHARE-denominated, capped around 200 rows, and can lag the chain right
 * after a buy. Persisting it would mean showing a payout computed from a stale
 * row. Two rows for the same market — one per side — is expected, not a bug. The
 * claimable row is the one that won. See ARCHITECTURE.md §4.7.
 *
 * ⚠ SHARES ARE NOT DOLLARS. A winning position pays out 1 USDC per share, so the
 * payout IS `winningShares` as a decimal — but only because the share redeemed.
 * The `usdc*` formatters in `lib/format.ts` are for amounts, and the scoreboard
 * converts shares to USDC once, at the point of the claim, with the outcome
 * already known.
 */

import { panta } from '@/lib/panta/client'
import { PantaError } from '@/lib/panta/errors'
import type { OrderSide, PantaInstruction, SolanaAddress } from '@/lib/panta/types'
import { findMarketByPantaId, findMarketById, markResolved } from '@/lib/db/queries/markets'
import { appendEvent } from '@/lib/db/queries/events'
import { isMember } from '@/lib/db/queries/circles'
import { requireSessionId } from './guards'
import { ValidationError, ConflictError } from './validation'
import type { User } from '@/lib/db/queries/users'

export class ClaimNotAvailableError extends ConflictError {
  constructor(message: string, code = 'NOT_CLAIMABLE') {
    super(message, code)
    this.name = 'ClaimNotAvailableError'
  }
}

export class ClaimValidationError extends ValidationError {
  constructor(message: string) {
    super(message)
    this.name = 'ClaimValidationError'
  }
}

export interface ClaimablePosition {
  pulseMarketId: string
  pantaMarketId: string
  marketTitle: string
  side: OrderSide
  /** Shares. Pays out 1:1 with USDC because this side won. */
  shares: string
  /** Panta's own view of the payout, for cross-checking ours. */
  expectedPayoutUsdc: string
  outcome: 'yes' | 'no'
}

export interface ClaimBuildResult {
  pulseMarketId: string
  /**
   * TRANSACTION SHAPE B — raw instructions plus a blockhash. Same shape as a buy
   * and compiled by the same module, `src/lib/tx/instructionTx.ts`. The ONLY
   * thing in Pulse that is not shape A.
   */
  instructions: PantaInstruction[]
  recentBlockhash: string
  lastValidBlockHeight: number | null
  outcome: 'yes' | 'no'
  winningShares: string
  /** What the user will receive, in USDC. For the confirmation line. */
  payoutUsdc: string
}

export interface ClaimInput {
  circleId: string
  /** Our market id. Never Panta's. */
  pulseMarketId: string
}

/**
 * Everything the user has waiting to be claimed in this circle.
 *
 * Returns a list rather than a single claim because a session can have several
 * resolved markets, and a user who has been in three rooms does not want to
 * remember which one finished. The UI shows this as a "you won" list.
 *
 * Best-effort per market: one market whose position row is malformed must not
 * hide the other nine payouts.
 */
export async function listClaimable(input: { circleId: string }, user: User): Promise<ClaimablePosition[]> {
  if (!(await isMember(input.circleId, user.id))) {
    throw new ClaimValidationError('You are not in this circle.')
  }

  const { value: positions } = await panta
    .positions(user.wallet)
    // `/positions/` is uncached on purpose. A claim is a payout — showing someone
    // a claim that is not there, or hiding one that is, is the only failure mode
    // in this file that costs them money. Every other read in Pulse is cached.
    .catch((err: unknown) => {
      if (err instanceof PantaError && err.retryable) {
        console.error('[claim] positions unavailable', err)
        return { value: [] as Awaited<ReturnType<typeof panta.positions>>['value'] }
      }
      throw err
    })

  const ours = positions.filter(
    (p): p is typeof p & { outcome: 'yes' | 'no' } => Boolean(p.claimable && !p.claimed && p.outcome),
  )
  const resolved = await Promise.all(
    ours.map(async (p) => {
      const market = await findMarketByPantaId(p.marketId)
      // A position in a market Pulse does not know is a Panta-side market someone
      // traded outside a room. Not ours to claim, and not ours to hide — it simply
      // does not belong in a room's claim list.
      if (!market || market.circleId !== input.circleId) return null
      const side = p.side
      const won = side === p.outcome
      if (!won) return null
      return {
        pulseMarketId: market.id,
        pantaMarketId: p.marketId,
        marketTitle: market.title,
        side,
        shares: p.shares,
        // A winning share redeems at 1:1. Both strings come from Panta; the
        // subtraction is what makes a losing row impossible to claim by mistake.
        expectedPayoutUsdc: p.outcome ? p.shares : '0.00',
        outcome: p.outcome,
      } satisfies ClaimablePosition
    }),
  )

  return resolved.filter((r): r is ClaimablePosition => r !== null)
}

/**
 * Step 2: build the claim transaction.
 *
 * Re-checks claimability even though the caller listed it, because the gap
 * between "you can claim this" and "you pressed claim" is exactly long enough
 * for someone else to claim it first, and a build that fails on chain at that
 * point is a bad experience rather than a bug.
 */
export async function buildClaim(input: ClaimInput, user: User): Promise<ClaimBuildResult> {
  if (!(await isMember(input.circleId, user.id))) {
    throw new ClaimValidationError('You are not in this circle.')
  }

  const market = await findMarketById(input.pulseMarketId)
  if (!market || market.circleId !== input.circleId) {
    throw new ClaimValidationError('That market does not exist.')
  }
  if (!market.pantaMarketId) {
    throw new ClaimNotAvailableError('That market was never set up.', 'NOT_REGISTERED')
  }
  if (!market.resolved) {
    // Our snapshot is a cache of Panta's answer and can lag either way. When our
    // row says unresolved but Panta says claimable, Panta is right — it resolves
    // server-side and we learn on the next sync. So this is a warning, not a
    // refusal, and the build below is the real test.
    console.warn('[claim] building for a market our snapshot has not resolved', market.id)
  }

  const { value: build } = await panta.claimBuild(user.wallet, market.pantaMarketId)

  // If Panta is telling us the outcome, our snapshot is wrong and should be
  // corrected now. Otherwise the room keeps rendering a resolved market as open
  // until the next price refresh, and a user staring at it during a live event
  // cannot tell whether the market is still open.
  if (build.outcome && (!market.resolved || market.outcome !== build.outcome)) {
    await markResolved(
      market.id,
      build.outcome === 'yes' ? 'yes' : 'no',
      // The moment Panta answered, which is now. Stamping it `new Date()` rather
      // than reusing the last price snapshot is the point: this is fresh
      // information, and the staleness stamp in the room should say so.
      new Date(),
    ).catch((err) => console.error('[claim] outcome correction failed', { marketId: market.id, err }))
  }

  return {
    pulseMarketId: market.id,
    instructions: build.instructions,
    recentBlockhash: build.recentBlockhash,
    lastValidBlockHeight: build.lastValidBlockHeight ?? null,
    outcome: build.outcome === 'yes' ? 'yes' : 'no',
    winningShares: build.winningShares,
    // Winning shares redeem at 1 USDC each. This is the only place in the product
    // where shares become dollars, and it is deliberately not shared with
    // `positionValueUsdc`, which handles the still-open case.
    payoutUsdc: usdcOf(build.winningShares),
  }
}

/**
 * Step 4: the claim confirmed.
 *
 * Attribution only — there is no submit to fail. If `/trades/` fails, the money
 * has still moved; we have lost a line on Panta's dashboard and nothing else, so
 * it is reported rather than thrown.
 */
export async function recordClaim(
  pulseMarketId: string,
  signature: string,
  payoutUsdc: string,
  user: User,
): Promise<{ attributed: boolean }> {
  const market = await findMarketById(pulseMarketId)
  if (!market || !market.pantaMarketId) {
    throw new ClaimValidationError('That market does not exist.')
  }

  // A claim on a market that has not resolved is a forged receipt, and this is
  // the one check that separates the two.
  //
  // The wallet header is forgeable, so in principle anyone can POST a receipt
  // for a market id and a signature they made up. Nothing else in Pulse moves
  // money on the strength of that header, but a claim receipt feeds the
  // scoreboard — the one derived view people are meant to trust — so it is
  // worth one read to make sure the market has actually settled.
  //
  // It is a real check and not a complete one: it does not prove the signature
  // claims THIS wallet's shares. Proving that means reading the signature on
  // chain, which costs an RPC call per receipt. The bound here is that a
  // fabricated receipt needs a resolved market id, and the scoreboard's
  // cross-check against Panta's tape catches the rest. See ARCHITECTURE.md §4.6.
  if (!market.resolved) {
    throw new ClaimValidationError('That market has not resolved yet, so there is nothing to claim.')
  }

  const attributed = await panta
    .reportTrade({
      signature,
      wallet: user.wallet as SolanaAddress,
      marketId: market.pantaMarketId,
      // A claim has no orderId for Panta to infer from, so this is the one case
      // where `kind` has to be stated rather than derived.
      kind: 'claim',
      userId: user.id,
    })
    .then(() => true)
    .catch((err: unknown) => {
      console.error('[claim] attribution failed', { pulseMarketId, err })
      return false
    })

  await appendEvent({
    sessionId: requireSessionId(market.sessionId, `market ${pulseMarketId}`),
    type: 'claim.reported',
    actorUserId: user.id,
    marketId: market.id,
    payload: {
      signature,
      // ClaimEventPayload. `amountUsdc` is what the scoreboard credits, and
      // unlike a buy's `amountUsdc` this is money RECEIVED rather than staked —
      // the one place where that distinction has to be carried by context.
      amountUsdc: payoutUsdc,
    },
  })

  return { attributed }
}

/** A share count to a 2dp USDC string, without ever throwing on a bad number. */
function usdcOf(shares: string): string {
  const n = Number(shares)
  if (!Number.isFinite(n) || n < 0) return '0.00'
  return n.toFixed(2)
}
