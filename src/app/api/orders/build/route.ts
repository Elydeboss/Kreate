import { buildBuy } from '@/server/marketBuy'
import { usdcDecimal, type OrderSide } from '@/lib/panta/types'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse, ValidationError } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, numField, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Step 2 of a buy: build the unsigned transaction.
 *
 *   POST /api/orders/build
 *   { circleId, pulseMarketId, quoteId, side, amountUsdc, maxSlippageBps? }
 *   -> { orderId, instructions, recentBlockhash, expectedShares, requoted, ... }
 *
 * ⚠ TRANSACTION SHAPE B. Raw `instructions[]` plus a blockhash — THE CLIENT
 * COMPILES THE MESSAGE ITSELF. This is not the pre-assembled blob a create
 * returns, and the two are not interchangeable. `src/lib/tx/instructionTx.ts`
 * builds this one; `src/lib/tx/createTx.ts` builds the other. Separate files, on
 * purpose, because calling `VersionedTransaction.deserialize()` on this response
 * at 2am before a demo is a mistake that typechecks.
 *
 * ⚠ ~60 SECOND CLOCK. The blockhash is good for about a minute, and the user has
 * to unlock a wallet and approve inside it. Nothing retries automatically on
 * this route: a transaction that arrives too late needs a fresh quote and a fresh
 * build, and the UI says so rather than appearing to hang.
 *
 * WHY `side` AND `amountUsdc` COME BACK WITH THE QUOTE ID. They are the requote
 * material. If the quote has gone stale — which on a live market in the last
 * seconds of a match is the common case, not the edge case — we re-quote once
 * here and rebuild, all inside the single tap the user already made. The
 * alternative is telling them the price moved and making them tap again, which
 * means a second wallet popup and a second chance to run out of time. The retry
 * is capped at exactly one: an auto-retry loop against a moving price is how you
 * fill someone at a number they never saw.
 *
 * `requoted: true` in the response is not cosmetic. When it is set, the prices
 * in this response differ from the ones the user was shown, and the UI must
 * display the new ones before they sign.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const quoteId = strField(body, 'quoteId')
    if (!quoteId) throw new ValidationError('Quote the market first.')

    const side = strField(body, 'side')
    if (side !== 'yes' && side !== 'no') {
      throw new ValidationError('Side must be YES or NO.')
    }
    const amountUsdc = strField(body, 'amountUsdc')
    if (!amountUsdc) throw new ValidationError('Enter an amount.')

    const input = {
      circleId: strField(body, 'circleId'),
      pulseMarketId: strField(body, 'pulseMarketId'),
      quoteId,
      maxSlippageBps: numField(body, 'maxSlippageBps') ?? undefined,
    }

    // The user is resolved BEFORE the idempotency hash is taken, not inside the
    // handler. Two reasons, and the second is the one that matters: a replay
    // still proves the caller is who they were, and the wallet is part of the
    // hashed body, so a key shared between two users is caught as a conflict
    // rather than handing one user another's order.
    const user = await userFromRequest(request)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/orders/build',
      { ...input, wallet: user.wallet },
      async () => {
        const built = await buildBuy({
          ...input,
          user,
          // The requote material, already shape-checked above. `buildBuy`
          // re-validates the amount through the same rules as the first quote.
          requote: { side: side as OrderSide, amountUsdc: usdcDecimal(amountUsdc) },
        })
        return { status: 200, response: built }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'orders/build')
  }
}
