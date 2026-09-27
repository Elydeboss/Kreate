import { requireMembership, findCircleById, listMembers, memberCount } from '@/lib/db/queries/circles'
import { findActiveSession, listSessionsForCircle, sweepExpiredSessions } from '@/lib/db/queries/sessions'
import { listSessionTrades } from '@/lib/db/queries/trades'
import { getScoreboard, hasResolvedMarkets } from '@/lib/db/queries/scoreboard'
import { optionalUserFromRequest } from '@/server/identity'
import { handleRouteError, jsonOk } from '@/server/http'
import { refreshSessionPrices, priceTtlMs } from '@/server/priceSync'

/**
 * The room. One GET, one screen.
 *
 *   GET /api/circles/[circleId]/room
 *
 * WHY ONE CALL AND NOT SIX. The room shows a member list, a market board, a trade
 * tape and a scoreboard. Fetching those as separate endpoints means four
 * round-trips on whatever connection the room is actually being watched on, four
 * chances for one of them to fail alone, and a screen that renders in four
 * stages. A mobile watch party is usually on 3G or a congested café wifi, so
 * this is the difference between a room that appears and a room that assembles.
 *
 * The cost is that a slow price refresh delays the members list too, which is why
 * the price refresh has its own bounded per-request cap rather than being allowed
 * to take as long as it likes. Anything genuinely unavailable is returned as null
 * with a reason, never as an error that blanks the screen.
 *
 * Membership is required. A circle is an invite code, and a circle's markets and
 * member list are not public.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RouteContext {
  params: Promise<{ circleId: string }>
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { circleId } = await context.params
    const user = await optionalUserFromRequest(request)
    if (!user) {
      return jsonOk({ error: 'Connect a wallet to open this room.' }, { status: 401 })
    }

    const circle = await findCircleById(circleId)
    if (!circle) return jsonOk({ error: 'No such circle.' }, { status: 404 })

    // The authorisation boundary. Throws rather than returning a nullable result,
    // so no call site can forget to check it.
    try {
      await requireMembership(circle.id, user.id)
    } catch {
      // Do not distinguish "does not exist" from "you are not a member" beyond
      // what the membership check already implies — but DO tell the truth about
      // a stranger with a bad code, so the UI can offer to join.
      return jsonOk(
        { error: 'You are not in this circle.', code: 'NOT_A_MEMBER', circleId: circle.id },
        { status: 403 },
      )
    }

    // Opportunistic expiry sweep. A session past its end time is over whether or
    // not anyone has marked it, and a cron for one UPDATE is not a dependency
    // worth having this week.
    await sweepExpiredSessions().catch((err) => console.error('[room] sweep failed', err))

    const active = await findActiveSession(circle.id)
    const session = active ?? (await listSessionsForCircle(circle.id, 1))[0] ?? null

    const [members, count] = await Promise.all([listMembers(circle.id), memberCount(circle.id)])

    if (!session) {
      return jsonOk({
        circle,
        session: null,
        members,
        memberCount: count,
        markets: [],
        tape: [],
        scoreboard: { rows: [], hasResults: false },
        staleness: { pricesAsOf: null, stale: false, degraded: null, ttlMs: priceTtlMs(0) },
        viewer: { userId: user.id, wallet: user.wallet },
      })
    }

    // Prices, tape, and resolution all move. The scoreboard does not until
    // something resolves, so it reads whatever the ledger already has.
    const price = await refreshSessionPrices(session.id).catch((err) => {
      console.error('[room] price refresh failed', err)
      return null
    })

    const [tape, scoreboardRows, resultsExist] = await Promise.all([
      listSessionTrades(session.id, 40),
      getScoreboard(session.id),
      hasResolvedMarkets(session.id),
    ])

    // Staleness is computed once, here, and shipped with the prices. The client
    // does not guess it, and there is no path where a price renders without a
    // timestamp beside it — that is the Panta ToU §5 requirement, and the only
    // reliable way to hold it is to make the timestamp part of the same payload.
    const pricesAsOf = newestSnapshot(price?.markets)
    const ageMs = pricesAsOf ? Date.now() - pricesAsOf.getTime() : Infinity
    const stale = !pricesAsOf || ageMs > (price?.ttlMs ?? 0)

    return jsonOk({
      circle,
      session,
      members,
      memberCount: count,
      markets: price?.markets ?? [],
      tape,
      scoreboard: {
        rows: scoreboardRows,
        // A session with nothing resolved returns rows that are all zero. Saying
        // so explicitly is what stops the UI rendering a wall of 0.00s as though
        // people had bet and broken even.
        hasResults: resultsExist,
      },
      staleness: {
        pricesAsOf,
        stale,
        degraded: price?.degraded ?? null,
        ttlMs: price?.ttlMs ?? priceTtlMs(0),
        deferred: price?.deferred ?? 0,
      },
      viewer: { userId: user.id, wallet: user.wallet },
    })
  } catch (err) {
    return handleRouteError(err, 'rooms')
  }
}

/**
 * The freshest snapshot in the room, which is the honest "as of" for the screen.
 *
 * Deliberately the NEWEST rather than the oldest or an average. A room where one
 * market is live and the rest are deferred should claim to be as fresh as the
 * market the user is actually looking at; a single worst-case timestamp would
 * make a healthy room look stale and trigger a false warning.
 *
 * The UI is responsible for stamping individual markets too — the room-level
 * value is for the header, not a substitute.
 */
function newestSnapshot(markets: Array<{ pricesAsOf: Date | null }> | undefined): Date | null {
  if (!markets || markets.length === 0) return null
  let newest: Date | null = null
  for (const market of markets) {
    if (!market.pricesAsOf) continue
    if (!newest || market.pricesAsOf > newest) newest = market.pricesAsOf
  }
  return newest
}
