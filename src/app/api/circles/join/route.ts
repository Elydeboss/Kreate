import { joinCircleByCode, type Circle } from '@/lib/db/queries/circles'
import { userFromRequest } from '@/server/identity'
import {
  BadRequestError,
  handleRouteError,
  idempotencyKeyFrom,
  jsonOk,
  readJson,
  strField,
} from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Join a circle by invite code.
 *
 *   POST /api/circles/join  { code } -> { circle, joined }
 *
 * `joined: false` is a success, not an error. A shared link is very often opened
 * twice — once to forward it, once to actually join — and answering the second
 * visit with an error would be both wrong and confusing. The two failure modes
 * that ARE errors are a code that matches nothing, and a code that is malformed.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CODE_PATTERN = /^[A-Za-z0-9]{5,8}$/

/**
 * A code that matches nothing is a 404 with a body, not a thrown error.
 *
 * Modelling it as a response rather than an exception keeps it inside the
 * idempotency record: a retried join with the same key replays the same 404
 * instead of re-running the lookup or — worse — being treated as a server fault
 * and having its key released.
 */
type JoinResponse =
  | { circle: Circle; joined: boolean }
  | { error: string; code: 'CODE_NOT_FOUND' }

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const code = strField(body, 'code')

    // Shape-checked before the lookup. The schema's CHECK is a backstop; this is
    // what turns a typo into "that does not look like a code" instead of a 500.
    if (!CODE_PATTERN.test(code)) {
      throw new BadRequestError('Invite codes are 5 to 8 letters and numbers.')
    }

    const result = await withIdempotency<JoinResponse>(
      idempotencyKeyFrom(request),
      'POST /api/circles/join',
      { code: code.toUpperCase() },
      async () => {
        const user = await userFromRequest(request)
        const outcome = await joinCircleByCode(code, user.id)

        if (!outcome) {
          return {
            status: 404,
            response: { error: 'No circle matches that code.', code: 'CODE_NOT_FOUND' } as const,
          }
        }
        return {
          status: 200,
          response: { circle: outcome.circle, joined: outcome.joined } as const,
        }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return handleRouteError(err, 'circles/join')
  }
}
