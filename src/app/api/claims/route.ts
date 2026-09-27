import { listClaimable } from '@/server/marketClaim'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse } from '@/server/validation'
import { handleRouteError, jsonOk, readJson } from '@/server/http'

/**
 * What THIS wallet can claim, right now.
 *
 *   GET /api/claims?circleId=...  -> { claims: [...] }
 *
 * DELIBERATELY NOT PART OF THE ROOM RESPONSE, and the reason is rate limits as
 * much as latency. `/positions/` is wallet-scoped, in the `positions` family
 * (60/min), and every user in a room hits it at once — twenty people opening a
 * room together is twenty calls against a per-KEY budget, on top of the price
 * refreshes. Folding it into the room GET would make the room's own price
 * refresh queue behind other people's position lookups. It is also a different
 * question: the room is "what is everyone doing", this is "what have I won".
 *
 * `/positions/` is read LIVE here and cached nowhere. It lags the chain right
 * after a buy, and a stale "you have nothing to claim" is the one answer in this
 * product that costs someone money they are owed. A payout is worth an extra
 * uncached round trip.
 *
 * Empty is a normal answer, not an error. Most people in most sessions have
 * nothing claimable, and a 204 or an error there would make the common case look
 * like a failure.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const circleId = url.searchParams.get('circleId')?.trim() ?? ''
    if (!circleId) {
      return jsonOk({ error: 'circleId is required.', code: 'INVALID' }, { status: 400 })
    }

    const user = await userFromRequest(request)
    const claims = await listClaimable({ circleId }, user)

    return jsonOk({ circleId, claims })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'claims')
  }
}
