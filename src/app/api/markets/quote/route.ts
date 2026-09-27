import { quoteCreateMarket, DuplicateMarketError } from '@/server/marketCreate'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse } from '@/server/validation'
import {
  handleRouteError,
  idempotencyKeyFrom,
  jsonOk,
  readJson,
  strField,
} from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Step 1 of market creation: quote it.
 *
 *   POST /api/markets/quote
 *   { circleId, sessionId, title, category, resolutionRule, sourcesOfTruth[], imageUrl }
 *   -> { pulseMarketId, createId, paymentUsdc, expiresAt }
 *
 * Split from the build because the build hands the client a transaction with a
 * ~60 second blockhash, and nobody should be asked to confirm a fee they have
 * only just learned. Quoting first puts the real, Panta-quoted price in front of
 * them while they are still deciding, and spends nothing.
 *
 * WHY THIS NEEDS AN IDEMPOTENCY KEY. A quote writes a `pulse_markets` row and
 * mints a createId. A double-tap, or a client retry after a timeout, would
 * otherwise leave two markets and two createIds for one human intention — and
 * because a createId eventually costs a real fee, the second one is money spent
 * on nothing. The key makes the retry replay the first result instead.
 *
 * ⚠ The fee comes back in the RESPONSE. It is not an input and the client cannot
 * cap it. The first quote of a session is therefore also the moment we learn what
 * a market costs, which is why `paymentUsdc` is surfaced rather than swallowed.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)

    const input = {
      circleId: strField(body, 'circleId'),
      sessionId: strField(body, 'sessionId'),
      title: strField(body, 'title'),
      category: strField(body, 'category'),
      resolutionRule: strField(body, 'resolutionRule'),
      imageUrl: strField(body, 'imageUrl'),
      sourcesOfTruth: strArrayField(body, 'sourcesOfTruth'),
      // A deliberate opt-in, never inferred. It mints a second market AND a
      // second fee, so the only way to turn it on is to ask for it by name.
      allowDuplicate: body.allowDuplicate === true,
    }
    // There is no amount, slippage or fee field here, and that is not an
    // oversight: Panta quotes the creation fee and the client cannot set it.

    // The user is resolved BEFORE the idempotency hash is taken, so the wallet is
    // part of the hashed body: a key shared between two users is caught as a
    // conflict rather than replaying one user's market to another.
    const user = await userFromRequest(request)

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/markets/quote',
      { ...input, wallet: user.wallet },
      async () => {
        const quoted = await quoteCreateMarket(input, user)
        return { status: 200, response: quoted }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    // A duplicate is a 409 carrying the existing market's id, because the right
    // response to "you already asked this" is to show them the market they asked
    // for — not an error, and not a second fee. That is the entire point of the
    // session nonce existing.
    const domain = domainErrorResponse(err)
    if (domain) {
      return err instanceof DuplicateMarketError
        ? jsonOk(
            { error: err.message, code: err.code, pulseMarketId: err.existingMarketId },
            { status: 409 },
          )
        : domain
    }
    return handleRouteError(err, 'markets/quote')
  }
}

function strArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}
