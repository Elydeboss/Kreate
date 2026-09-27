import { buildCreateTransaction } from '@/server/marketCreate'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Step 2 of market creation: build the unsigned transaction.
 *
 *   POST /api/markets/build  { createId } -> { transaction, recentBlockhash, ... }
 *
 * ⚠ TRANSACTION SHAPE A. A base64-encoded, pre-assembled VersionedTransaction
 * with a blockhash already inside it. The client deserializes, signs, broadcasts.
 * It is NOT an `instructions[]` list — buys and claims return that instead, and
 * the two are not interchangeable. `src/lib/tx/createTx.ts` handles this one and
 * `src/lib/tx/instructionTx.ts` handles the other, in separate files on purpose.
 *
 * WHY AN IDEMPOTENCY KEY. Building mints a fresh blockhash and can move a fee.
 * A double-tap here is a user who has agreed to pay twice for the same market, so
 * the key is not ceremony — it is the difference between one fee and two.
 *
 * ⚠ THE CLOCK STARTS HERE. The blockhash in `transaction` is good for roughly
 * 60 seconds. That budget covers the client deserializing it, the user unlocking
 * a wallet, reading the fee, and approving. Nothing is retried automatically on
 * this route: a build that arrives too late is answered by a fresh quote and a
 * fresh build, and the UI says so rather than appearing to hang.
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

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/markets/build',
      { createId },
      async () => {
        const user = await userFromRequest(request)
        const built = await buildCreateTransaction(createId, user)
        return { status: 200, response: built }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'markets/build')
  }
}
