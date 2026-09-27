import { quoteBuy } from '@/server/marketBuy'
import { PantaError, buyErrorMessage } from '@/lib/panta/errors'
import type { OrderSide } from '@/lib/panta/types'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse, ValidationError } from '@/server/validation'
import { handleRouteError, jsonOk, numField, readJson, strField } from '@/server/http'

/**
 * Step 1 of a buy: quote it.
 *
 *   POST /api/orders/quote
 *   { circleId, pulseMarketId, side, amountUsdc, maxSlippageBps? }
 *   -> { quoteId, shares, avgPrice, feeUsdc, expiresAt }
 *
 * NO IDEMPOTENCY KEY, and that is a considered difference from the create flow.
 * A quote writes nothing: no market row, no order row, no ledger entry. Panta
 * mints a quoteId and forgets it in ~90 seconds. The worst a duplicate quote can
 * do is spend one slot in the `quote` family (30/min) and return a fresher price,
 * which is strictly better for the user. Requiring a key here would be ceremony
 * that buys nothing and adds a failure mode to the most common action in the
 * product.
 *
 * The create flow earns its key because a create writes a row and eventually
 * costs a fee. A quote costs a header.
 *
 * ⚠ `pulseMarketId`, never Panta's market id. The client only ever knows ours;
 * the translation happens in `quoteBuy` against a row we own, which is also what
 * stops a caller from buying a market in a circle they are not in.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // The body is read before the try so that `side` is in scope in the catch. A
  // failed buy should say "the YES price moved" rather than "the price moved",
  // and recovering the side from the thrown error would mean restructuring the
  // happy path around the failure path.
  const body = await readJson(request)
  const requested = strField(body, 'side')
  const side: OrderSide = requested === 'no' ? 'no' : 'yes'

  try {
    if (requested !== 'yes' && requested !== 'no') {
      throw new ValidationError('Side must be YES or NO.')
    }

    const user = await userFromRequest(request)
    const quoted = await quoteBuy(
      {
        circleId: strField(body, 'circleId'),
        pulseMarketId: strField(body, 'pulseMarketId'),
        side,
        amountUsdc: strField(body, 'amountUsdc'),
        maxSlippageBps: numField(body, 'maxSlippageBps') ?? undefined,
      },
      user,
    )

    return jsonOk(quoted)
  } catch (err) {
    // Side-aware copy first, because "the YES price moved, review and confirm
    // again" is actionable and "the price moved" is not. The status, the code
    // and the retryable flag all still come from the shared Panta mapping.
    if (err instanceof PantaError) {
      const headers: Record<string, string> = {}
      if (typeof err.shape.retryAfterSec === 'number') {
        headers['Retry-After'] = String(Math.max(1, Math.ceil(err.shape.retryAfterSec)))
      }
      return jsonOk(
        { error: buyErrorMessage(err.shape, side), code: err.code, retryable: err.retryable },
        { status: err.status, headers },
      )
    }
    return domainErrorResponse(err) ?? handleRouteError(err, 'orders/quote')
  }
}
