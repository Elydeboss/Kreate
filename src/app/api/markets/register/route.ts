import { registerCreatedMarket } from '@/server/marketCreate'
import { userFromRequest } from '@/server/identity'
import { requireSignature } from '@/server/guards'
import { domainErrorResponse } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Step 3 of market creation: the signature came back.
 *
 *   POST /api/markets/register  { createId, signature } -> { pantaMarketId, ... }
 *
 * The ONLY thing the client ever sends after signing is a signature. The signed
 * transaction itself never reaches this server, and never reaches any server —
 * it goes from the wallet to the RPC node. That is the whole reason the create
 * flow is shaped as three endpoints instead of one: there is nothing here worth
 * stealing, and nothing here worth subpoenaing.
 *
 * SAFE TO RETRY. Every step is idempotent, because a POST that times out on café
 * wifi is indistinguishable from one that never arrived, and the right answer to
 * "I do not know whether that landed" is to make landing twice look like landing
 * once. The idempotency key makes a client's blind retry correct rather than a
 * second registration.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const createId = strField(body, 'createId')
    if (!createId) {
      return jsonOk({ error: 'createId is required.', code: 'INVALID' }, { status: 400 })
    }
    // Shape-checked here rather than forwarded to Panta. A truncated signature is
    // an upstream 400 that reads like a Panta fault and spends a slot in the
    // tightest rate-limit family we have.
    const signature = requireSignature(body.signature)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/markets/register',
      { createId, signature },
      async () => {
        const user = await userFromRequest(request)
        const registered = await registerCreatedMarket(createId, signature, user)
        return { status: 200, response: registered }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'markets/register')
  }
}
