import 'server-only'

/**
 * Market creation: quote -> build -> [client signs] -> register.
 *
 * THE ORDER IS THE WHOLE DESIGN, so read this before reordering anything.
 *
 *   1. Write a `pulse_markets` row, `panta_market_id` still NULL.
 *   2. Quote Panta. Get a `createId` and the real fee. Write `panta_creates`.
 *   3. Build Panta. Get an UNSIGNED transaction. Return it to the client.
 *   4. ......... client signs and broadcasts; the server is not involved ........
 *   5. Client POSTs the signature. Register with Panta, attach the market id.
 *
 * Step 1 happens before step 2 so that a failure at any later point leaves
 * evidence. A create that is only recorded after success leaves nothing behind
 * when it fails, and "why is there a market with no Panta id" then has no answer.
 * The fee is real money, so the audit trail matters more than the tidiness of a
 * clean rollback.
 *
 * Step 3-4 is the reason the server never holds a signed transaction. Broadcasting
 * happens in the browser. A server that never sees one has nothing to leak and
 * nothing to be subpoenaed for. See AGENTS.md rule 5.
 *
 * ⚠ `imageUrl` is required by Panta and must be a public HTTPS URL from their
 * image catalog. It is the single most common reason a create fails on stage. We
 * pre-seed tiles rather than uploading live, because the catalog helper can 503
 * with UPLOAD_NOT_CONFIGURED. See ARCHITECTURE.md §3.6.
 */

import { panta } from '@/lib/panta/client'
import { PantaError } from '@/lib/panta/errors'
import { usdcDecimal, type PantaCategory, type SolanaAddress, type UsdcDecimal } from '@/lib/panta/types'
import { insertMarket, attachPantaMarketId, findOpenMarketByTitle, nonceQuestion, findMarketById } from '@/lib/db/queries/markets'
import { recordCreate, markCreateRegistered, markCreateStatus, findCreate } from '@/lib/db/queries/pantaFlows'
import { appendEvent } from '@/lib/db/queries/events'
import { requireSessionId } from './guards'
import { ValidationError, ConflictError } from './validation'
import { findSessionById, type LiveSession } from '@/lib/db/queries/sessions'
import { requireMembership } from '@/lib/db/queries/circles'
import { isMarketCategory, MARKET_CATEGORIES, type MarketCategory } from '@/lib/db/queries/markets'
import type { User } from '@/lib/db/queries/users'

/** Live Mode is always `breaking` + `eventInProgress`. See ARCHITECTURE.md §3.4. */
const LIVE_MARKET_TYPE = 'breaking' as const
const LIVE_EVENT_IN_PROGRESS = true

export interface CreateMarketInput {
  circleId: string
  sessionId: string
  /** The clean question as a person typed it. This is what the room displays. */
  title: string
  category: string
  resolutionRule: string
  sourcesOfTruth: string[]
  imageUrl: string
  /**
   * Mint a unique market even if this question is already open in the session.
   * Costs a SECOND real fee, so it is opt-in and never the default. See
   * ARCHITECTURE.md §4.3 on DUPLICATE_MARKET.
   */
  allowDuplicate?: boolean
}

export interface CreateQuoteResult {
  pulseMarketId: string
  createId: string
  /** The fee Panta actually quoted, as a decimal string for display. */
  paymentUsdc: UsdcDecimal
  /** True when an open market with this question already existed. */
  duplicateOf?: string
}

export class DuplicateMarketError extends ConflictError {
  readonly existingMarketId: string
  constructor(existingMarketId: string) {
    super('That market is already open in this session.', 'DUPLICATE_MARKET')
    this.name = 'DuplicateMarketError'
    this.existingMarketId = existingMarketId
  }
}

/**
 * Step 1 and 2: record the attempt, then quote Panta.
 *
 * Split from `buildCreateTransaction` on purpose. The client quotes when the
 * create sheet opens, so the user sees the real fee BEFORE committing, and build
 * only on confirm — because Panta's blockhash is good for ~60s and a user reading
 * a fee is going to take longer than that.
 */
export async function quoteCreateMarket(
  input: CreateMarketInput,
  user: User,
): Promise<CreateQuoteResult> {
  await requireMembership(input.circleId, user.id)

  const session = await findSessionById(input.sessionId)
  if (!session) throw new ValidationError('That session does not exist.')
  if (session.circleId !== input.circleId) {
    throw new ValidationError('That session is not in this circle.')
  }
  if (session.status !== 'active') {
    throw new ValidationError('That session has ended.')
  }

  // Capture into a const so the type guard's narrowing survives. Using
  // `input.category` after the check re-widens it back to `string`, which is how
  // `category: input.category as never` ends up in code that looks like a smell
  // and behaves like a bug.
  const category = input.category
  if (!isMarketCategory(category)) {
    throw new ValidationError(
      `Category must be one of: ${MARKET_CATEGORIES.join(', ')}.`,
    )
  }
  const imageUrl = validateImageUrl(input.imageUrl)
  const title = input.title.trim()
  if (title.length === 0) throw new ValidationError('The market needs a question.')
  if (title.length > 200) throw new ValidationError('Keep the question under 200 characters.')
  if (input.resolutionRule.trim().length === 0) {
    throw new ValidationError('The market needs a resolution rule.')
  }

  // The app-layer half of the DUPLICATE_MARKET workaround. Checked BEFORE the
  // quote, because the quote is the call that costs nothing but the build after it
  // costs a fee — and better, check before either.
  if (!input.allowDuplicate) {
    const existing = await findOpenMarketByTitle(input.sessionId, title)
    if (existing) throw new DuplicateMarketError(existing.id)
  }

  // Every market inherits the session's deadline, so all markets in a watch party
  // close together and the scoreboard has a boundary. Deriving it per market would
  // let one market outlive the room it belongs to.
  //
  // `startTime` is the session's own start, which is already in the past. That is
  // not a shortcut, it is the entire point of `eventInProgress` — without it Panta
  // demands a start at least an hour out, which is unaskable mid-match.
  const nowSec = Math.floor(Date.now() / 1000)
  const startTimeSec = Math.floor(session.startedAt.getTime() / 1000)
  const endTime = Math.floor(session.endsAt.getTime() / 1000)
  // Panta settles the market itself; we can only ask it to look after the close.
  const resolutionTime = endTime + 300

  // ⚠ Panta validates the timing triangle itself, and both of its failures are
  // 400s whose messages read like a bug rather than a rule:
  //   breaking + eventInProgress  => startTime <= now < endTime
  //   breaking + !eventInProgress => startTime > now   (the on-chain flash window)
  // We only ever send the first arm, but it bites in one real case: a session
  // created seconds ago whose startedAt rounds to the current second. Checking
  // here turns that into a sentence a person can act on.
  if (startTimeSec > nowSec) {
    throw new ValidationError('This session has not started yet.')
  }
  if (endTime <= nowSec) {
    throw new ValidationError('That session has already ended.')
  }
  if (resolutionTime <= endTime) {
    throw new ValidationError('Resolution has to come after the market closes.')
  }

  // The nonce-bearing question. Panta derives the event PDA from (question,
  // wallet), so the same wallet asking the same question twice is a 400. The nonce
  // goes in `question` and never in `title`, so the room still reads clean.
  const question = nonceQuestion(title, sessionNonce(session.id))

  // Step 1: the row exists before any money is involved.
  const market = await insertMarket({
    circleId: input.circleId,
    sessionId: input.sessionId,
    createdBy: user.id,
    question,
    title,
    resolutionRule: input.resolutionRule.trim(),
    sourcesOfTruth: input.sourcesOfTruth,
    category,
    imageUrl,
    marketType: LIVE_MARKET_TYPE,
    startTime: startTimeSec,
    endTime,
    resolutionTime,
  })

  // Step 2: quote, and record the createId the moment we have one.
  try {
    const response = await panta.createQuote({
      // The wallet that will sign. Panta derives the market PDA from
      // (question, wallet) and rejects a register signed by anyone else.
      wallet: user.wallet as SolanaAddress,
      question,
      title,
      // The guard above already proved this is in the app's allowlist. The app
      // list and Panta's list are hand-kept in sync; `npm run verify` asserts
      // they still agree, so a drift breaks the build and not the demo.
      category: category as PantaCategory,
      imageUrl,
      marketType: LIVE_MARKET_TYPE,
      eventInProgress: LIVE_EVENT_IN_PROGRESS,
      resolutionRule: input.resolutionRule.trim(),
      sourcesOfTruth: input.sourcesOfTruth,
      startTime: startTimeSec,
      endTime,
      resolutionTime,
      // ⚠ NO paymentUsdc. Panta quotes the creation fee and returns it; the
      // client cannot choose or cap it. Every published example shows
      // paymentUsdc on the RESPONSE and invites you to copy it into the request,
      // where it is ignored or rejected. The number that comes back is the real
      // budget line. See ARCHITECTURE.md §3.3.
      //
      // Panta-side attribution. Sent on quote AND build, so /account/metrics/ and
      // /account/trades/ credit this Pulse user rather than the API key.
      userId: user.id,
    })

    // `.value`, not `.data`. Every Panta call resolves to a PantaResponse<T>
    // that extends the cache result, so the payload is always one hop away.
    const { value: quote } = response

    await recordCreate({
      createId: quote.createId,
      pulseMarketId: market.id,
      wallet: user.wallet,
      // Stored as the string Panta quoted, never parsed. It is read back for
      // reconciliation against the eventual charge, and a float round-trip would
      // destroy the precision being checked.
      paymentUsdc: quote.paymentUsdc,
      expectedEventPda: quote.expectedEventPda ?? null,
    })

    return {
      pulseMarketId: market.id,
      createId: quote.createId,
      paymentUsdc: fromBaseUnitsSafe(quote.paymentUsdc),
    }
  } catch (err) {
    // The market row stays, deliberately. `panta_creates` has no row because no
    // createId was ever minted, and `markMarketFailed` would only be for a create
    // that got as far as a createId. Leaving the row means the ops page can show
    // a half-attempted market, which is a real thing that happens.
    if (err instanceof PantaError && err.code === 'DUPLICATE_MARKET') {
      // Panta rejected it even with our nonce, which means the session nonce
      // collided or the same title was created on Panta outside Pulse. Surface
      // the real reason rather than a generic failure.
      throw new DuplicateMarketError(market.id)
    }
    throw err
  }
}

export interface CreateBuildResult {
  createId: string
  /**
   * TRANSACTION SHAPE A. A base64-encoded, pre-assembled VersionedTransaction,
   * already carrying a blockhash. The client deserializes and signs it. It is
   * NOT an instructions[] list — that is shape B, used by buys and claims, and
   * the two are not interchangeable.
   */
  transaction: string
  recentBlockhash: string
  lastValidBlockHeight: number | null
  /**
   * The fee THIS build will charge. Compared against the quote before signing: if
   * they differ, something changed between the two calls and the user should be
   * asked again rather than surprised.
   */
  paymentUsdc: string
  expiresAt: string | null
}

/**
 * Step 3: ask Panta for the unsigned transaction.
 *
 * Called on confirm, not on quote. The blockhash inside is good for ~60s, and the
 * path from here to broadcast includes a wallet popup on a phone. Building at
 * quote time means the user's careful "yes" arrives after the transaction died.
 *
 * The wallet is required here and must be the one that was quoted — Panta ties the
 * built transaction to it, and a mismatch fails at register with a much worse
 * message than a missing field.
 */
export async function buildCreateTransaction(
  createId: string,
  user: User,
): Promise<CreateBuildResult> {
  const create = await findCreate(createId)
  if (!create) {
    // We only ever build what we quoted. Building an arbitrary createId would
    // spend a fee on a market our ledger has no record of, which is exactly the
    // kind of untraceable spend this product promises never to make.
    throw new ValidationError('That create is not a known Pulse create.')
  }
  if (create.wallet !== user.wallet) {
    throw new ValidationError('That create belongs to a different wallet.')
  }

  const { value: build } = await panta.createBuild({
    createId,
    wallet: user.wallet as SolanaAddress,
    userId: user.id,
  })

  return {
    createId: build.createId,
    transaction: build.transaction,
    recentBlockhash: build.recentBlockhash,
    lastValidBlockHeight: build.lastValidBlockHeight ?? null,
    paymentUsdc: build.paymentUsdc,
    expiresAt: build.expiresAt ?? null,
  }
}

/**
 * Step 5: the client came back with a signature.
 *
 * Registers with Panta and attaches the market id. If Panta rejects the signature
 * the market row stays unregistered and the room does not show it — which is
 * correct, since a market nobody can trade is not a market.
 *
 * REPLAY-SAFE. Every step is idempotent, because the client will genuinely retry
 * this: a POST that times out on café wifi is indistinguishable from one that
 * never arrived, and the honest response to "I don't know if that landed" is to
 * make landing twice indistinguishable from landing once. `/markets/register/`
 * is idempotent on (createId, signature) per Panta's docs; `markCreateRegistered`
 * only moves a row out of `pending`; `attachPantaMarketId` only fills a null. So
 * a second call returns the same market rather than an error, and a client that
 * retries blindly does the right thing.
 */
export async function registerCreatedMarket(
  createId: string,
  signature: string,
  user: User,
): Promise<{ pulseMarketId: string; pantaMarketId: string; status: string }> {
  const { value: registered } = await panta.register({ createId, signature })

  // Mark first, then attach. If the mark is a no-op because this exact create is
  // already registered, fall through to the idempotent read below rather than
  // reporting a failure for something that already succeeded.
  const moved = await markCreateRegistered(createId, signature)
  const create = moved ?? (await findCreate(createId))
  if (!create) {
    // No row at all means this createId was never ours or the row was reaped.
    // Attaching a Panta market id to a market we cannot identify would corrupt
    // the room for everyone, so this is the one case that is a hard failure.
    throw new ValidationError('That create is not a known Pulse create.')
  }
  if (create.wallet !== user.wallet) {
    throw new ValidationError('That create belongs to a different wallet.')
  }

  const market = await attachPantaMarketId(create.pulseMarketId, registered.marketId)
  if (!market) {
    // Already attached, so this market already has an id. Confirm they agree and
    // return the settled state — a disagreement means two different Panta
    // markets are trying to claim one Pulse market, which is a real problem.
    const existing = await findMarketById(create.pulseMarketId)
    if (existing?.pantaMarketId === registered.marketId) {
      return {
        pulseMarketId: existing.id,
        pantaMarketId: registered.marketId,
        status: create.status,
      }
    }
    throw new ValidationError('That market is already registered to a different Panta market.')
  }

  await appendEvent({
    // Refuse rather than assert: a market that somehow has no session must never
    // write a sessionless event. See guards.ts.
    sessionId: requireSessionId(market.sessionId, `create ${createId}`),
    type: 'market.registered',
    actorUserId: user.id,
    marketId: market.id,
    payload: {
      pantaMarketId: registered.marketId,
      signature,
      // The fee actually quoted, for the ops page and the room's spend column.
      paymentUsdc: create.paymentUsdc,
    },
  })

  return {
    pulseMarketId: market.id,
    pantaMarketId: registered.marketId,
    status: registered.status,
  }
}

/**
 * Abandon a create.
 *
 * A 409 or a user who closed the tab. Marks the create `expired` rather than
 * deleting it, because "we tried and it did not land" is exactly the state that
 * needs to be answerable when someone asks whether they were charged.
 */
export async function abandonCreate(createId: string, reason: string): Promise<void> {
  const create = await markCreateStatus(createId, 'expired')
  if (create) {
    console.warn(`[create] ${createId} abandoned: ${reason}`)
  }
}

/**
 * A short, stable nonce per session.
 *
 * NOT random per create. The point is that a session's markets are distinguishable
 * from each other, not that they are unguessable. Deriving it from the session id
 * means a rehearsal that creates the same three markets three times produces the
 * same three questions, and a crash mid-create can be resumed with the same
 * string rather than minting a fourth fee.
 */
function sessionNonce(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8).toUpperCase()
}

/**
 * Validate an image URL against what Panta will accept.
 *
 * Panta requires a public HTTPS URL from its image catalog, recommends
 * 1024x1024, and rejects data URLs outright. Checking here means a bad URL is a
 * 400 with a sentence a person can act on, rather than a 400 from Panta with a
 * code nobody recognises. Data URLs are rejected explicitly because they are
 * syntactically valid and Panta's rejection would otherwise be the only signal.
 */
function validateImageUrl(raw: string): string {
  const value = raw.trim()
  if (value.length === 0) throw new ValidationError('The market needs an image.')
  if (value.startsWith('data:')) {
    throw new ValidationError('The image must be a hosted URL, not an embedded one.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ValidationError('The image URL is not a valid URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError('The image URL must be https.')
  }
  return value
}

/** Panta's base-unit string to a display decimal, without a hard failure. */
function fromBaseUnitsSafe(base: string): UsdcDecimal {
  const n = Number(base)
  if (!Number.isFinite(n)) return usdcDecimal('0.00')
  return usdcDecimal((n / 1_000_000).toFixed(2))
}

export type { LiveSession }
