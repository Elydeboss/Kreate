import { submitBuy, abandonOrder } from '@/server/marketBuy'
import { userFromRequest } from '@/server/identity'
import { requireSignature } from '@/server/guards'
import { domainErrorResponse, ValidationError } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Step 3 of a buy: the signature came back.
 *
 *   POST /api/orders/submit  { orderId, signature } -> { status, attributed }
 *
 * The signed transaction never reaches this server. It goes from the wallet
 * straight to the RPC node, and all we ever see is the 88 characters Panta and
 * the chain use to identify it. That is the whole design, and it is why this
 * route is safe to expose: there is nothing here but an id and a signature.
 *
 * `attributed: false` IS A SUCCESS. The buy has happened — the shares are the
 * user's and the chain has settled it. What failed is the courtesy receipt to
 * Panta, which costs us a line on their dashboard and nothing else. Reporting
 * that as an error would tell a user their money did not move when it did, which
 * is the single worst thing this endpoint could do. The UI shows "bought" and
 * logs the attribution failure for us to chase.
 *
 * SAFE TO RETRY. `/primaryordersubmit/` and `/trades/` are both idempotent, the
 * ledger write only moves an order forward once, and the idempotency key makes a
 * client's blind retry replay the first answer.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const orderId = strField(body, 'orderId')
    if (!orderId) throw new ValidationError('orderId is required.')
    const signature = requireSignature(body.signature)

    const user = await userFromRequest(request)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/orders/submit',
      { orderId, signature, wallet: user.wallet },
      async () => {
        const submitted = await submitBuy(orderId, signature, user)
        return { status: 200, response: submitted }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'orders/submit')
  }
}

/**
 * Give up on an order the user never signed.
 *
 *   DELETE /api/orders/submit  { orderId }
 *
 * A separate verb rather than a field on the POST because it is a different
 * intention: this one is the user closing the sheet. A user who backs out of the
 * wallet prompt has left a `built` order with a live blockhash and no signature,
 * and without this the order sits there until something reaps it. The row is
 * marked `expired`, never deleted — a transaction that may or may not have landed
 * is exactly the state that has to stay answerable.
 *
 * Deliberately NOT idempotency-keyed. It is a local state change with no upstream
 * effect, it is safe to repeat, and requiring a header on a cleanup path means the
 * path is skipped whenever the client is the least able to send one.
 */
export async function DELETE(request: Request) {
  try {
    const body = await readJson(request)
    const orderId = strField(body, 'orderId')
    if (!orderId) throw new ValidationError('orderId is required.')

    const user = await userFromRequest(request)
    await abandonOrder(orderId, user.wallet, 'client closed the buy sheet')

    return jsonOk({ orderId, status: 'expired' })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'orders/abandon')
  }
}
