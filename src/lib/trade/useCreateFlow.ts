'use client'

/**
 * The create state machine — TRANSACTION SHAPE A.
 *
 * This is the flow that dies on stage, so the shape of it is mostly about not
 * being the thing that dies. Three things kill it, in the order they actually
 * happen:
 *
 *   1. THE FEE IS UNKNOWN UNTIL YOU ASK. `paymentUsdc` is not an input. It comes
 *      back on the quote, from Panta, and the client cannot cap it. So the sheet
 *      quotes on open and shows the real number while the user is still deciding.
 *      Building first would mean asking someone to confirm an amount they have
 *      not seen, which for a real fee is not a confirmation.
 *
 *   2. THE BLOCKHASH IS ~60 SECONDS. It is minted by the build, and the path from
 *      there to broadcast includes a wallet popup. So the build happens on the
 *      tap that means it, never earlier.
 *
 *   3. THE FEE CAN MOVE BETWEEN QUOTE AND BUILD. The build quotes again. If it
 *      differs, the user is asked again — the flow does not sign at a number they
 *      did not agree to. This is the one that is easy to "optimise away" and the
 *      one that would spend someone's money without asking.
 *
 * DUPLICATE_MARKET IS A SUCCESS, NOT AN ERROR. Panta derives the event PDA from
 * (question, wallet), so asking the same question twice is a 400. The server puts
 * a session nonce in `question` so the same words mint a different market, and
 * the app layer checks for an already-open market first. If either catches it,
 * the right response is to show the market they already asked for — not an error,
 * and never a second fee, which is why `allowDuplicate` exists and is opt-in by
 * name.
 *
 * ONCE, NOT TWICE. A create mints a market AND a fee. An auto-retry after a
 * timeout is how one intention becomes two fees, so every step here is
 * idempotent and there is no retry loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import { ApiError, buildMarket, newIdempotencyKey, quoteMarket, registerMarket } from '@/lib/client/api'
import type { CreateBuild, CreateQuote } from '@/lib/client/api'
import { signAndSendCreateTx } from '@/lib/tx/createTx'
import { confirmTransaction } from '@/lib/tx/broadcast'
import type { TxSigner } from '@/lib/tx/instructionTx'

export type CreateStage =
  | 'editing'
  | 'quoting'
  | 'quoted'
  | 'building'
  | 'signing'
  | 'broadcasting'
  | 'confirming'
  | 'registering'
  | 'done'
  | 'error'

export interface CreateState {
  stage: CreateStage
  quote: CreateQuote | null
  /** The fee THIS build will charge. Null until the build returns. */
  buildFee: string | null
  /**
   * True when the fee changed between quote and build. The flow stops here and
   * asks again — it will not sign at a number the user has not seen.
   */
  feeChanged: boolean
  /** An already-open market with this question. Not an error; the answer. */
  duplicateOf: string | null
  error: string | null
  signature: string | null
  createdMarketId: string | null
  cancelled: boolean
}

const INITIAL: CreateState = {
  stage: 'editing',
  quote: null,
  buildFee: null,
  feeChanged: false,
  duplicateOf: null,
  error: null,
  signature: null,
  createdMarketId: null,
  cancelled: false,
}

/** createId lives about 5 minutes. Only used to warn. */
const CREATE_TTL_SEC = 300

const BUSY: ReadonlySet<CreateStage> = new Set([
  'quoting',
  'building',
  'signing',
  'broadcasting',
  'confirming',
  'registering',
])

export interface UseCreateFlowParams {
  connection: Connection
  signer: TxSigner | null
  wallet: string
  circleId: string
  sessionId: string
  title: string
  category: string
  resolutionRule: string
  sourcesOfTruth: string[]
  imageUrl: string
  onSettled?: (marketId: string) => void
}

export interface UseCreateFlow {
  state: CreateState
  /** Step 1. Safe on open; costs nothing but a quote-family rate slot. */
  quote: () => Promise<void>
  /**
   * Steps 2-4, and the only tap that spends money. Refuses to proceed if the
   * build's fee differs from the quote's, leaving the user on the quoted number
   * with a button that says so.
   */
  confirm: () => Promise<void>
  /** Re-quote after a fee change or an expiry. */
  requote: () => Promise<void>
  cancel: () => void
  reset: () => void
  busy: boolean
}

export function useCreateFlow(params: UseCreateFlowParams): UseCreateFlow {
  const {
    connection,
    signer,
    wallet,
    circleId,
    sessionId,
    title,
    category,
    resolutionRule,
    sourcesOfTruth,
    imageUrl,
    onSettled,
  } = params

  const [state, setState] = useState<CreateState>(INITIAL)
  const mounted = useRef(true)

  const quoteKey = useRef<string | null>(null)
  const buildKey = useRef<string | null>(null)
  const registerKey = useRef<string | null>(null)
  const createId = useRef<string | null>(null)
  /** Latest-wins counter for quotes. See the input-change effect above. */
  const gen = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A different question is a different market and a different createId. Reusing
  // either would build the wrong thing, and charge the wrong thing's fee.
  //
  // This clears the STATE as well as the keys, and the state is the part that
  // matters. Without it the sheet keeps showing the fee quoted for the PREVIOUS
  // question, next to the question the user is now looking at, and `confirm`
  // then builds a createId that no longer matches the text on screen. The first
  // version of this effect only nulled the refs, so the displayed fee outlived
  // the input it was quoted for — which is the one thing a fee display must never
  // do.
  //
  // `gen` is bumped here for a different reason: an in-flight quote for the old
  // question can resolve after this effect runs, and would land a fee for a
  // question that no longer exists. Same latest-wins rule as the buy flow, for
  // the same reason.
  useEffect(() => {
    gen.current += 1
    quoteKey.current = null
    buildKey.current = null
    registerKey.current = null
    createId.current = null
    // `mounted` is false during the first effect pass in React 18 StrictMode's
    // double-invoke, and `patch` would drop the reset. The store is written
    // directly so the sheet always lands back on a blank, unquoted form.
    if (mounted.current) setState(INITIAL)
  }, [title, category, circleId, sessionId])

  const patch = useCallback((next: Partial<CreateState>) => {
    if (!mounted.current) return
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  const isUserRejection = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err)
    return /reject|cancel|denied|declined|user (?:closed|cancell?ed)|not (?:agreed|approved)/i.test(message)
  }

  const runQuote = useCallback(async () => {
    if (!signer) return
    quoteKey.current ??= newIdempotencyKey()
    const mine = (gen.current += 1)
    patch({
      stage: 'quoting',
      error: null,
      cancelled: false,
      signature: null,
      feeChanged: false,
      duplicateOf: null,
    })

    try {
      const result = await quoteMarket(
        wallet,
        { circleId, sessionId, title, category, resolutionRule, sourcesOfTruth, imageUrl },
        quoteKey.current,
      )
      // A newer question, or a newer quote, has moved on. This response is for a
      // market that is no longer on screen, so it is dropped whole — including
      // its createId, which would otherwise be confirmed against a question the
      // user has since retyped.
      if (gen.current !== mine) return
      createId.current = result.createId
      patch({ stage: 'quoted', quote: result, buildFee: result.paymentUsdc })
    } catch (err) {
      if (gen.current !== mine) return
      // A duplicate is a 409 carrying the market that already exists. It is the
      // most likely thing to happen when a host re-asks a question that is
      // already open, and it is the answer, not a failure.
      if (err instanceof ApiError && err.status === 409) {
        createId.current = null
        patch({
          stage: 'quoted',
          duplicateOf: (err as ApiError & { marketId?: string }).marketId ?? null,
          error: null,
        })
        return
      }
      patch({
        stage: 'error',
        error: err instanceof ApiError ? err.message : 'Could not price that market.',
      })
    }
  }, [signer, wallet, circleId, sessionId, title, category, resolutionRule, sourcesOfTruth, imageUrl, patch])

  const confirm = useCallback(async () => {
    if (!signer || !state.quote || !createId.current) return
    if (BUSY.has(state.stage) || state.duplicateOf) return

    buildKey.current ??= newIdempotencyKey()
    registerKey.current ??= newIdempotencyKey()

    // ── Build. The ~60s blockhash clock starts here. ───────────────────────
    patch({ stage: 'building', error: null })
    let build: CreateBuild
    try {
      build = await buildMarket(wallet, createId.current, buildKey.current)
    } catch (err) {
      // The createId is the casualty of a late build. There is nothing to retry
      // into, so the user re-quotes explicitly rather than the hook looping.
      patch({
        stage: 'quoted',
        error: err instanceof ApiError ? err.message : 'That attempt expired. Ask again.',
      })
      return
    }

    // ⚠ THE GATE. The build quoted the fee again and it is not the number the
    // user agreed to. Signing here would spend a different amount than the one
    // on screen, and "it went up by a bit" is not consent. The fee is Panta's to
    // set — there is no cap field and no way to bid under it — so the only
    // honest move is to stop and show the new one.
    if (build.paymentUsdc !== state.quote.paymentUsdc) {
      patch({
        stage: 'quoted',
        buildFee: build.paymentUsdc,
        feeChanged: true,
        error: 'The fee changed. Nothing has been charged — ask again to see the new one.',
      })
      // The createId is spent: a build was made against it, and a second build
      // on the same id is not a documented operation. So there is nothing left
      // for `confirm` to sign, and the recovery is a fresh quote — which is also
      // the honest shape, because the user has to agree to a number they have
      // seen, not to one that appeared after they tapped.
      //
      // `state.feeChanged` is what the sheet branches on. Leaving `stage` at
      // 'quoted' alone was a trap: the sheet's first branch is `stage === 'quoted'
      // -> confirm`, so the button offered to pay a fee whose createId no longer
      // existed, and `confirm` returned silently. The label said "accept the new
      // fee" and the tap did nothing at all.
      createId.current = null
      quoteKey.current = null
      return
    }

    // ── Sign. SHAPE A: a pre-assembled base64 blob, not an instruction list. ─
    patch({ stage: 'signing' })
    let signature: string
    try {
      signature = await signAndSendCreateTx({ connection, build, signer })
    } catch (err) {
      patch(
        isUserRejection(err)
          ? { stage: 'quoted', cancelled: true, error: null }
          : {
              stage: 'error',
              error: err instanceof Error ? err.message : 'Your wallet could not sign that.',
            },
      )
      return
    }

    // ── Confirm. ───────────────────────────────────────────────────────────
    patch({ stage: 'broadcasting', signature })
    try {
      if (build.lastValidBlockHeight) {
        patch({ stage: 'confirming' })
        await confirmTransaction({
          connection,
          signature,
          lastValidBlockHeight: build.lastValidBlockHeight,
        })
      }
    } catch {
      // A confirmation timeout is not a failure. The bytes were broadcast and
      // `/markets/register/` is idempotent on (createId, signature), so the
      // register below may well succeed. Reporting failure here would push the
      // user into a second create, which is a second fee.
    }

    // ── Register. This is what tells Panta the market exists. ──────────────
    patch({ stage: 'registering' })
    try {
      const registered = await registerMarket(wallet, createId.current, signature, registerKey.current)
      patch({ stage: 'done', createdMarketId: registered.pulseMarketId })
      onSettled?.(registered.pulseMarketId)
    } catch (err) {
      // Same reasoning as the confirmation. The transaction is on chain; the
      // market exists whether or not our row caught up. The room re-reads, and
      // a market with no price yet is visibly pending rather than missing.
      console.error('[create] register failed', err)
      patch({
        stage: 'error',
        error:
          'The market is on chain but we could not finish registering it. It may appear in a moment.',
      })
    }
  }, [
    signer,
    state.quote,
    state.stage,
    state.duplicateOf,
    wallet,
    connection,
    patch,
    onSettled,
  ])

  const cancel = useCallback(() => {
    setState((prev) => ({ ...INITIAL, stage: 'quoted', cancelled: true, quote: prev.quote }))
  }, [])

  const reset = useCallback(() => {
    quoteKey.current = null
    buildKey.current = null
    registerKey.current = null
    createId.current = null
    setState(INITIAL)
  }, [])

  return {
    state,
    quote: runQuote,
    confirm,
    requote: runQuote,
    cancel,
    reset,
    busy: BUSY.has(state.stage),
  }
}

export { CREATE_TTL_SEC }
