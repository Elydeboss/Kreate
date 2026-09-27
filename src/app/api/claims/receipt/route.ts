import { recordClaim } from '@/server/marketClaim'
import { userFromRequest } from '@/server/identity'
import { requireSignature } from '@/server/guards'
import { domainErrorResponse, ValidationError } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, numField, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * The claim confirmed.
 *
 *   POST /api/claims/receipt  { pulseMarketId, signature, payoutUsdc? }
 *   -> { attributed }
 *
 * THERE IS NO CLAIM SUBMIT. This is the step people look for and it does not
 * exist: the claim is finished the moment the transaction confirms on chain, and
 * everything here is bookkeeping — the receipt to Panta and the event our own
 * scoreboard reads. A build that models a submit response for claims is describing
 * an endpoint that is not there, and a demo that waits for one waits forever.
 *
 * `payoutUsdc` is taken from the client because the server cannot know it: the
 * payout is `winningShares` from a build that was minted ~60 seconds ago and has
 * since been signed by a wallet and forgotten by the tab that built it. It is
 * bounded here for the same reason — an unbounded number from a client that
 * cannot be authenticated is a number that eventually will not be. The real
 * integrity check is in `recordClaim`: a receipt for a market that has not
 * resolved is refused, which is the only forgery a forged header can otherwise
 * reach the scoreboard with. See ARCHITECTURE.md §4.6.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The largest single claim we will record.
 *
 * A sanity bound, not a policy. A payout above this means the client's number is
 * wrong, and writing it would corrupt the one derived view in the product that
 * people are meant to trust.
 */
const MAX_CLAIM_USDC = 100_000

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const pulseMarketId = strField(body, 'pulseMarketId')
    if (!pulseMarketId) throw new ValidationError('pulseMarketId is required.')
    const signature = requireSignature(body.signature)

    const claimed = numField(body, 'payoutUsdc')
    if (claimed !== null && (claimed < 0 || claimed > MAX_CLAIM_USDC)) {
      throw new ValidationError('That payout does not look right.')
    }

    const user = await userFromRequest(request)
    const payoutUsdc = claimed === null ? '0.00' : claimed.toFixed(2)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/claims/receipt',
      { pulseMarketId, signature, wallet: user.wallet },
      async () => {
        // Attribution failure is reported, not thrown: the money has already moved.
        const recorded = await recordClaim(pulseMarketId, signature, payoutUsdc, user)
        return { status: 200, response: recorded }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'claims/receipt')
  }
}
