import { createCircleForWallet, listCirclesForUser } from '@/lib/db/queries/circles'
import { userFromRequest } from '@/server/identity'
import {
  BadRequestError,
  handleRouteError,
  idempotencyKeyFrom,
  jsonError,
  jsonOk,
  readJson,
  strField,
} from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Circles: create and list.
 *
 *   GET  /api/circles           -> the caller's circles
 *   POST /api/circles  { name } -> create; returns the invite code
 *
 * POST is idempotent and requires an `Idempotency-Key`. A retried create must not
 * produce a second circle and a second invite code, because a user who taps twice
 * on a bad connection would end up with two groups and no way to tell which one
 * their friends joined.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_NAME_LENGTH = 60

export async function GET(request: Request) {
  try {
    const user = await userFromRequest(request)
    const circles = await listCirclesForUser(user.id)
    return jsonOk({ circles })
  } catch (err) {
    return handleRouteError(err, 'circles')
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const name = strField(body, 'name')

    // Checked here as well as by the schema's CHECK constraint, so an over-long
    // name is a 400 with a useful message rather than a 500 from a violation.
    if (name.length === 0) throw new BadRequestError('Give your circle a name.')
    if (name.length > MAX_NAME_LENGTH) {
      throw new BadRequestError(`Keep it under ${MAX_NAME_LENGTH} characters.`)
    }

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/circles',
      { name },
      async () => {
        const user = await userFromRequest(request)
        const circle = await createCircleForWallet(name, user.wallet, user.displayName)
        return { status: 201, response: { circle } }
      },
    )

    // A replayed response is indistinguishable from a fresh one, which is the
    // point. The header is for debugging, not for client branching.
    return jsonOk(result.response, {
      status: result.status,
      headers: result.replayed ? { 'Idempotent-Replay': 'true' } : undefined,
    })
  } catch (err) {
    return handleRouteError(err, 'circles')
  }
}
