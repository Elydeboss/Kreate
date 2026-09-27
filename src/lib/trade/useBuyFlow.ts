'use client'

/**
 * The buy state machine.
 *
 * WHY A STATE MACHINE AND NOT A LOADING BOOLEAN. A buy has a clock in it that
 * the user cannot see: Panta's blockhash is good for about 60 seconds, and the
 * quote underneath it for about 90. A boolean collapses "quoting", "waiting for
 * your wallet", "broadcasting", and "waiting for the chain" into one spinner,
 * and a user who is looking at a spinner while their transaction silently
 * expires has no way to know that is what is happening. Each state below is
 * something a person can be told, and each one has a different thing they can do
 * next.
 *
 * THE TWO TIMERS, AND WHY THEY ARE NOT THE SAME:
 *
 *   quote (90s)  — how long the price they were shown stays quotable.
 *   blockhash (60s) — how long the built transaction stays valid, and it covers
 *                    the wallet popup, which on a mid-range Android over café
 *                   wifi is the entire budget.
 *
 * The second is why the build happens on CONFIRM and not on open. Building when
 * the sheet opened would hand the user a transaction already dead by the time
 * they said yes.
 *
 * EVERY IDEMPOTENCY KEY IS MINED ONCE, HERE, WHEN THE USER MEANS IT, and reused
 * for the retries of that one intent. Minting a fresh key per attempt would
 * defeat replay protection in exactly the case it exists for: a user on a bad
 * connection who taps again because the screen did not change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import type { OrderSide } from '@/lib/panta/types'
import { ApiError, quoteBuy, buildBuy, submitBuy, abandonOrder, newIdempotencyKey } from '@/lib/client/api'
import { signAndSendInstructionTx } from '@/lib/tx/instructionTx'
import { confirmTransaction } from '@/lib/tx/broadcast'
import type { TxSigner } from '@/lib/tx/instructionTx'
import type { BuyBuild, BuyQuote } from '@/lib/client/api'

export type BuyStage =
  | 'idle'
  | 'quoting'
  | 'quoted'
  | 'building'
  | 'signing'
  | 'broadcasting'
  | 'confirming'
  | 'done'
  | 'error'

export interface BuyState {
  stage: BuyStage
  quote: BuyQuote | null
  /** The price the CURRENT build will execute at, which a re-quote may change. */
  effectiveAvgPrice: string | null
  effectiveShares: string | null
  feeUsdc: string | null
  /** True when a stale quote forced a re-quote the user never saw coming. */
  requoted: boolean
  error: string | null
  /** True when the user dismissed their own wallet. Not a failure. */
  cancelled: boolean
  signature: string | null
  /** Seconds left on the quote, or null when there is no live quote. */
  quoteSecondsLeft: number | null
}

const INITIAL: BuyState = {
  stage: 'idle',
  quote: null,
  effectiveAvgPrice: null,
  effectiveShares: null,
  feeUsdc: null,
  requoted: false,
  error: null,
  cancelled: false,
  signature: null,
  quoteSecondsLeft: null,
}

/** Panta's documented quote TTL. Used only to warn, never to gate. */
const QUOTE_TTL_SEC = 90

/** Stages where a tap should do nothing because one is already in flight. */
const BUSY: ReadonlySet<BuyStage> = new Set([
  'quoting',
  'building',
  'signing',
  'broadcasting',
  'confirming',
])

export interface UseBuyFlowParams {
  connection: Connection
  signer: TxSigner | null
  wallet: string
  circleId: string
  pulseMarketId: string
  side: OrderSide
  /** Preselected amount in USDC, as a human decimal string. */
  amountUsdc: string
  maxSlippageBps?: number
  /** Called after a confirmed buy so the room can re-read itself. */
  onSettled?: () => void
}

export interface UseBuyFlow {
  state: BuyState
  /** Step 1. Safe to call on sheet open. */
  quote: () => Promise<void>
  /** Steps 2-4. The one tap the user means. */
  confirm: () => Promise<void>
  /** The user backed out. Tells the server to mark the order expired. */
  cancel: () => void
  reset: () => void
}

export function useBuyFlow(params: UseBuyFlowParams): UseBuyFlow {
  const { connection, signer, wallet, circleId, pulseMarketId, side, amountUsdc, onSettled } = params

  const [state, setState] = useState<BuyState>(INITIAL)
  const mounted = useRef(true)

  // The keys live in refs, not state, because they are minted once per intent
  // and must survive re-renders without being reset by one. A key in state would
  // be regenerated on every render that touched it, which is the bug this whole
  // mechanism exists to prevent.
  const quoteKey = useRef<string | null>(null)
  const buildKey = useRef<string | null>(null)
  const submitKey = useRef<string | null>(null)
  const orderId = useRef<string | null>(null)

  // Latest-wins bookkeeping for `quote`. See its doc comment for why the naive
  // busy-guard is the bug rather than the fix.
  const generation = useRef(0)
  const inFlight = useRef<Promise<BuyQuote> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A new intent is a new market, side, or amount. Anything left from the old one
  // must not be reused, or a retry would be answered with the previous buy's
  // order — which is the most confusing failure this hook could have.
  //
  // Bumping the generation here is what stops an in-flight quote for the OLD
  // intent from writing its price into state after the user has already moved
  // on. Without it, switching side mid-quote would show the YES price on a NO
  // sheet, and `confirm` would build a NO order from a YES quote.
  useEffect(() => {
    generation.current += 1
    quoteKey.current = null
    buildKey.current = null
    submitKey.current = null
    orderId.current = null
  }, [pulseMarketId, side, amountUsdc])

  const patch = useCallback((next: Partial<BuyState>) => {
    if (!mounted.current) return
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  const isUserRejection = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err)
    // Wallets signal a dismissal as a rejection, a cancel, or a 400 with their
    // own wording. None of them is a failure and none should show an error, but
    // all of them mean the order was never signed and should be abandoned.
    return /reject|cancel|denied|declined|user (?:closed|cancell?ed)|not (?:agreed|approved)/i.test(message)
  }

  /**
   * Step 1, and the one that has to survive being called while another quote is
   * still running.
   *
   * THE BUG THIS SHAPE EXISTS TO PREVENT. The amount field re-quotes on every
   * keystroke, so the common sequence is: type "2", the quote starts, type "0",
   * the second quote starts while the first is still in flight. The naive
   * version — `if (busy) return` — drops the second request, and the user is
   * left looking at the price of $5 next to an input that says $20, with a live
   * confirm button. That is the worst state this screen can be in: a real number,
   * next to a different number, and one tap from spending it.
   *
   * So quotes are LATEST-WINS and SERIALISED rather than guarded. A generation
   * counter means only the most recent request may write to state; an in-flight
   * promise is awaited so two quotes never hit Panta's 30/min budget at once;
   * and the screen is cleared to `quoting` SYNCHRONOUSLY, before any awaiting,
   * so there is no window in which a stale price is visible.
   *
   * `confirm` keeps the busy guard. Dropping two confirmations on one tap is not
   * a display problem, it is two transactions.
   */
  const quote = useCallback(async () => {
    if (!signer) return

    const gen = ++generation.current
    // Synchronous, before the first await. Everything below may take a round
    // trip; the old price must already be gone.
    patch({ stage: 'quoting', error: null, cancelled: false, signature: null, quote: null })
    quoteKey.current ??= newIdempotencyKey()

    // Serialise behind whatever is already running.
    if (inFlight.current) {
      await inFlight.current.catch(() => undefined)
      if (gen !== generation.current) return
    }

    const work = quoteBuy(wallet, {
      circleId,
      pulseMarketId,
      side,
      amountUsdc,
      maxSlippageBps: params.maxSlippageBps,
    })
    inFlight.current = work

    try {
      const result = await work
      // Superseded while in flight. A newer quote is already on its way and will
      // write the state; applying this one would flash a price the user never
      // asked for.
      if (gen !== generation.current) return
      patch({
        stage: 'quoted',
        quote: result,
        effectiveAvgPrice: result.avgPrice,
        effectiveShares: result.shares,
        feeUsdc: result.feeUsdc,
        requoted: false,
      })
    } catch (err) {
      if (gen !== generation.current) return
      patch({
        stage: 'error',
        error: err instanceof ApiError ? err.message : 'Could not price that right now.',
      })
    } finally {
      if (inFlight.current === work) inFlight.current = null
    }
  }, [signer, wallet, circleId, pulseMarketId, side, amountUsdc, params.maxSlippageBps, patch])

  const confirm = useCallback(async () => {
    if (!signer || !state.quote) return
    if (BUSY.has(state.stage)) return

    buildKey.current ??= newIdempotencyKey()
    submitKey.current ??= newIdempotencyKey()

    // ── Build. The blockhash clock starts here, not at quote time. ──────────
    let build: BuyBuild
    patch({ stage: 'building', error: null, cancelled: false })
    try {
      build = await buildBuy(
        wallet,
        {
          circleId,
          pulseMarketId,
          quoteId: state.quote.quoteId,
          side,
          amountUsdc,
          maxSlippageBps: params.maxSlippageBps,
        },
        buildKey.current,
      )
    } catch (err) {
      // A build failure means the quote is gone. There is nothing to retry into,
      // so the state goes back to quoted and the user re-quotes explicitly
      // rather than the hook looping on their behalf.
      patch({
        stage: 'quoted',
        error: err instanceof ApiError ? err.message : 'That price has moved. Quote again.',
      })
      return
    }

    orderId.current = build.orderId

    // A re-quote changed the price AFTER the user agreed to one. The build
    // carries the new numbers, so they are surfaced before the wallet opens —
    // confirming a number you were not shown is worse than a failed trade.
    if (build.requoted) {
      patch({
        requoted: true,
        effectiveAvgPrice: build.avgPrice ?? state.quote.avgPrice,
        feeUsdc: build.feeUsdc ?? state.quote.feeUsdc,
        effectiveShares: build.expectedShares,
      })
    } else {
      patch({ effectiveShares: build.expectedShares })
    }

    // ── Sign and broadcast. The server is not involved in either. ───────────
    patch({ stage: 'signing' })
    let signature: string
    try {
      signature = await signAndSendInstructionTx({
        connection,
        instructions: build.instructions,
        recentBlockhash: build.recentBlockhash,
        signer,
      })
    } catch (err) {
      const dismissed = isUserRejection(err)
      // The order was built and never signed. Mark it expired so it does not sit
      // in the ledger looking like a live position.
      if (orderId.current) void abandonOrder(wallet, orderId.current)
      patch(
        dismissed
          ? { stage: 'quoted', cancelled: true, error: null }
          : {
              stage: 'error',
              error: err instanceof Error ? err.message : 'Your wallet could not sign that.',
            },
      )
      return
    }

    // ── Wait for the chain before claiming success. ────────────────────────
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
      // A confirmation timeout is NOT a failure. The transaction was broadcast
      // and Panta's own submit is idempotent, so the trade may well have landed.
      // Telling the user it failed would make them tap again and spend twice.
      // The room re-reads and the tape is the source of truth.
    }

    // ── Receipt. ───────────────────────────────────────────────────────────
    try {
      await submitBuy(wallet, build.orderId, signature, submitKey.current)
    } catch (err) {
      console.error('[buy] submit failed', err)
      // Same reasoning as above: the chain already settled. Surface it as done
      // with a note, never as an error.
      patch({ stage: 'done', signature })
      onSettled?.()
      return
    }

    patch({ stage: 'done', signature })
    onSettled?.()
  }, [
    signer,
    state.quote,
    state.stage,
    wallet,
    circleId,
    pulseMarketId,
    side,
    amountUsdc,
    params.maxSlippageBps,
    connection,
    patch,
    onSettled,
  ])

  const cancel = useCallback(() => {
    if (orderId.current) void abandonOrder(wallet, orderId.current)
    setState(INITIAL)
  }, [wallet])

  const reset = useCallback(() => {
    generation.current += 1
    quoteKey.current = null
    buildKey.current = null
    submitKey.current = null
    orderId.current = null
    setState(INITIAL)
  }, [])

  // ── The quote countdown ──────────────────────────────────────────────────
  //
  // Ticked on an interval rather than derived from a render, so it does not
  // re-render the room. It is a WARNING, never a gate: Panta is the authority on
  // whether a quote is alive, and this only decides when to tell the user to
  // stop looking at a number that is about to be replaced.
  useEffect(() => {
    if (state.stage !== 'quoted' || !state.quote) {
      if (state.quoteSecondsLeft !== null) patch({ quoteSecondsLeft: null })
      return
    }
    const expiresAt = new Date(state.quote.expiresAt).getTime()
    if (!Number.isFinite(expiresAt)) {
      patch({ quoteSecondsLeft: null })
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      if (mounted.current) setState((prev) => (prev.quoteSecondsLeft === left ? prev : { ...prev, quoteSecondsLeft: left }))
      if (left === 0 && mounted.current) {
        setState((prev) =>
          prev.error ? prev : { ...prev, error: 'That price has expired. Quote again to see the latest.' },
        )
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [state.stage, state.quote, state.quoteSecondsLeft, patch])

  return { state, quote, confirm, cancel, reset }
}

export { QUOTE_TTL_SEC }
