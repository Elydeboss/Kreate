import { buildClaim } from '@/server/marketClaim'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse, ValidationError } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Build the claim transaction.
 *
 *   POST /api/claims/build  { circleId, pulseMarketId }
 *   -> { instructions, recentBlockhash, outcome, winningShares, payoutUsdc }
 *
 * ⚠ TRANSACTION SHAPE B. Raw `instructions[]` plus a blockhash; the client
 * compiles the message. Same module as a buy — `src/lib/tx/instructionTx.ts` —
 * and a different one from a create.
 *
 * Unlike a create, this route takes no amount. There is nothing to choose: a
 * claim redeems every winning share the wallet holds in that market, and a
 * partial claim is not a thing Panta offers. The payout is a consequence of the
 * position, not an input to it, which is why `payoutUsdc` is in the RESPONSE and
 * not the request.
 *
 * THE POSITION IS READ LIVE FROM PANTA HERE, NOT FROM OUR CACHE. `/positions/`
 * is uncached in this flow and deliberately so: showing someone a claim that is
 * not there, or hiding one that is, is the only failure mode in the claim path
 * that costs them actual money. Every other read in Pulse is cached; this is not.
 *
 * IDEMPOTENCY KEY, because a repeated build mints a second blockhash and spends a
 * slot in the `build` family — the tightest limit we have at 20/min, shared by
 * every user of the key.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const pulseMarketId = strField(body, 'pulseMarketId')
    if (!pulseMarketId) throw new ValidationError('pulseMarketId is required.')

    const circleId = strField(body, 'circleId')
    const user = await userFromRequest(request)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/claims/build',
      { circleId, pulseMarketId, wallet: user.wallet },
      async () => {
        const built = await buildClaim({ circleId, pulseMarketId }, user)
        return { status: 200, response: built }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'claims/build')
  }
}
