import {
  startSession,
  endSession,
  findSessionById,
  ActiveSessionExistsError,
  DEFAULT_DURATION_MINUTES,
} from '@/lib/db/queries/sessions'
import { requireMembership } from '@/lib/db/queries/circles'
import { userFromRequest } from '@/server/identity'
import { domainErrorResponse, ValidationError, ConflictError, NotFoundError } from '@/server/validation'
import { handleRouteError, idempotencyKeyFrom, jsonOk, numField, readJson, strField } from '@/server/http'
import { withIdempotency } from '@/server/idempotency'

/**
 * Start and end watch-party sessions.
 *
 *   POST /api/sessions  { circleId, title, durationMinutes? }  -> 201 { session }
 *   POST /api/sessions  { sessionId, action: 'end' }           -> 200 { session }
 *
 * ONE ROUTE, TWO SHAPES, because both are the same intent — the room's live
 * state changed — and a client that polls one path does not have to know which
 * verb it just used.
 *
 * WHY THIS ROUTE IS NOT AN AFTERTHOUGHT. Every market in the product inherits
 * its `startTime` and `endTime` from its session. That inheritance is precisely
 * what makes a mid-match market possible: `startTime` has to be in the past, and
 * the only timestamp that reliably is, is the session's own start. So with no
 * session, `quoteCreateMarket` throws "That session does not exist" and the
 * product has no reachable core loop — no market, no trade, no tape, no
 * scoreboard. The `startSession` query was written, race-safe and all, and
 * nothing called it.
 *
 * DURATION. Defaults to 120 minutes, which is a football match plus the halftime
 * conversation. The client may ask for less and deliberately cannot ask for
 * more: a session that outlives the thing being watched produces markets that
 * outlive the room, and the session's end is a boundary the scoreboard depends
 * on. `startSession` also floors `ends_at` at one minute out, because a session
 * that has already expired cannot have a market created inside it.
 *
 * ENDING IS AUTHORISED AGAINST THE SESSION'S OWN CIRCLE, not one from the body.
 * The end shape carries no `circleId` — it has no reason to, the session knows
 * its circle — so taking one from the caller would mean trusting a value the
 * caller chose. Looking it up means someone who guesses a session id still has to
 * be in the room to shut it down.
 *
 * ENDING IS IDEMPOTENT. `endSession` is `WHERE id = $1` with no status filter
 * and `COALESCE(ended_at, now())`, so ending twice ends once. That matters
 * because the two callers are exactly the two that double: the user tapping
 * "end", and the room's poll noticing it already ended and tidying up.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    const user = await userFromRequest(request)

    // ── End ────────────────────────────────────────────────────────────────
    // Read and branch before any validation, because this shape carries a
    // sessionId and no circleId. Validating fields it does not have would reject
    // the one request a client most needs to be able to make.
    if (body.action === 'end') {
      const sessionId = strField(body, 'sessionId')
      if (!sessionId) throw new ValidationError('sessionId is required to end a session.')

      const result = await withIdempotency(
        idempotencyKeyFrom(request),
        'POST /api/sessions:end',
        { sessionId, wallet: user.wallet },
        async () => {
          const session = await findSessionById(sessionId)
          if (!session) throw new NotFoundError('That session does not exist.')
          await requireMembership(session.circleId, user.id)

          const ended = await endSession(sessionId)
          // Cannot be null — we just read the row and nothing deleted it in
          // between — but a null here would be a lost write, so it is reported
          // rather than passed off as an ended session.
          if (!ended) throw new NotFoundError('That session does not exist.')
          return { status: 200, response: { session: ended } }
        },
      )

      return jsonOk(result.response, { status: result.status })
    }

    // ── Start ──────────────────────────────────────────────────────────────
    const circleId = strField(body, 'circleId')
    if (!circleId) throw new ValidationError('circleId is required.')

    const title = strField(body, 'title')
    if (!title) throw new ValidationError('Give the session a name.')
    if (title.length > 120) throw new ValidationError('Keep the name under 120 characters.')

    // `numField` returns null for "absent", and `startSession` takes
    // `undefined` for "use the default". Converting at the edge keeps that
    // distinction from leaking into the query's own default, which would then
    // have to handle two spellings of the same thing.
    const requested = numField(body, 'durationMinutes')
    const durationMinutes = requested ?? undefined
    if (durationMinutes !== undefined && (durationMinutes < 1 || durationMinutes > DEFAULT_DURATION_MINUTES)) {
      throw new ValidationError(`A session runs for 1 to ${DEFAULT_DURATION_MINUTES} minutes.`)
    }

    const result = await withIdempotency(
      idempotencyKeyFrom(request),
      'POST /api/sessions',
      { circleId, title, durationMinutes: durationMinutes ?? null, wallet: user.wallet },
      async () => {
        await requireMembership(circleId, user.id)
        try {
          const session = await startSession({ circleId, title, durationMinutes })
          return { status: 201, response: { session } }
        } catch (err) {
          // The pre-check and the partial unique index both land here, for the
          // same reason. A 409 rather than a 500 because the honest response to
          // "you already have one running" is to show the one that is running,
          // which is what the room's next poll will do anyway.
          if (err instanceof ActiveSessionExistsError) {
            throw new ConflictError(
              'This room is already live. End the current session first.',
              'SESSION_ALREADY_ACTIVE',
            )
          }
          throw err
        }
      },
    )

    return jsonOk(result.response, { status: result.status })
  } catch (err) {
    return domainErrorResponse(err) ?? handleRouteError(err, 'sessions')
  }
}
