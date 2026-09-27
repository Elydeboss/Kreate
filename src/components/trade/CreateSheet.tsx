'use client'

/**
 * The create sheet: question, category, fee, sign.
 *
 * The demo-hostile decisions are all about not asking a person to do bookkeeping
 * while a match is on.
 *
 * THE RESOLUTION RULE IS PRE-FILLED, NOT ASKED FOR. Panta requires a non-empty
 * `resolutionRule` and the server refuses without one — so it is required, and
 * asking a host on a phone to compose one mid-match is how the demo dies. It is
 * derived from the question, editable under "details", and always sent. The
 * alternative — a required empty field — is the same product with an extra step
 * and a worse one.
 *
 * SOURCES ARE PRE-FILLED PER CATEGORY, for the same reason, and are also
 * editable. "Official competition result" is the right source for a football
 * market and the wrong one for a crypto market, which is why it is chosen by
 * category rather than hardcoded.
 *
 * THE IMAGE IS NOT A FIELD. It is derived from the category and the app's own
 * origin, so a host cannot pick a URL that Panta cannot fetch. This is the single
 * most reliable way to lose a live create, and it is now a category tap rather
 * than a text box.
 *
 * ⚠ LOCALHOST IS REFUSED, EXPLICITLY. Panta fetches `imageUrl` from its own
 * servers, so a tile served from `localhost` is unreachable and the create is
 * rejected *after* the user has confirmed a real fee. The sheet says so and
 * disables the button, because the alternative is a failure the user pays for.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Connection } from '@solana/web3.js'
import { useCreateFlow, type CreateStage } from '@/lib/trade/useCreateFlow'
// From ./tileUrl and NOT ./tiles. The painter imports node:zlib, and webpack
// cannot put that in a browser bundle — importing tileUrl from the same module
// that holds the encoder broke `next build` with an UnhandledSchemeError while
// leaving both tsc and the verify script green. See src/lib/image/tileUrl.ts.
import { tileUrl } from '@/lib/image/tileUrl'
import { isPublicOrigin } from '@/lib/client/origin'
import { usdc } from '@/lib/format'
import { TxLink } from '@/components/compliance/PantaCompliance'
import type { TxSigner } from '@/lib/tx/instructionTx'

/**
 * A default resolution source per category.
 *
 * Not decoration: `sourcesOfTruth` is what Panta's resolver reads, and a source
 * list that names a football feed for a token price is worse than no list at
 * all. Editable, because the host knows the specific competition and we do not.
 */
const DEFAULT_SOURCE: Record<string, string> = {
  sports: 'The official result published by the competition organiser.',
  crypto: 'The published price on the reference exchange at the resolution time.',
  politics: 'The official announcement from the relevant authority.',
  entertainment: 'The official result or announcement from the rights holder.',
  finance: 'The published closing figure from the reference source.',
  science: 'The published result from the research institution or observatory.',
  world: 'The official statement from the relevant national or international body.',
  other: 'A publicly verifiable published source, named at resolution time.',
}

/**
 * Build a resolution rule from the question.
 *
 * A prediction market's question is already a yes/no proposition — "Will X
 * happen?", not "X vs Y" — so the rule is the same shape for every one of them.
 * That is why this can be generated: there is no per-market logic to supply.
 */
function deriveRule(title: string): string {
  const question = title.trim().replace(/\?+$/, '')
  return (
    `Resolves YES if "${question}?" is true at the scheduled resolution time, ` +
    `according to the source of truth named on this market. Resolves NO otherwise. ` +
    `If the sources disagree or the event is cancelled, this market resolves NO.`
  )
}

/**
 * How long the question must be still before it is worth a Panta round trip.
 *
 * Long enough that a fast typist produces one quote rather than one per
 * character, short enough that the fee still feels like it was asked for. The
 * sheet cannot see the API key's remaining quota, so it cannot be adaptive here;
 * it can only be conservative.
 */
const QUOTE_DEBOUNCE_MS = 700

const STAGE_COPY: Partial<Record<CreateStage, string>> = {
  quoting: 'Asking Panta what this costs…',
  building: 'Building the transaction…',
  signing: 'Approve in your wallet…',
  broadcasting: 'Sending…',
  confirming: 'Confirming on chain…',
  registering: 'Telling Panta the market exists…',
}

export interface CreateSheetProps {
  categories: readonly string[]
  circleId: string
  sessionId: string
  connection: Connection
  signer: TxSigner | null
  wallet: string
  onClose: () => void
  onCreated: (marketId: string) => void
}

export function CreateSheet({
  categories,
  circleId,
  sessionId,
  connection,
  signer,
  wallet,
  onClose,
  onCreated,
}: CreateSheetProps) {
  const [question, setQuestion] = useState('')
  const [category, setCategory] = useState<string>(categories[0] ?? 'other')
  const [source, setSource] = useState<string>(DEFAULT_SOURCE[category] ?? DEFAULT_SOURCE.other!)
  const [ruleOverride, setRuleOverride] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [origin, setOrigin] = useState('')

  // Read once, on the client. A tile URL built on the server would carry the
  // server's idea of the origin, which is not the one the user's browser is on
  // and not the one Panta should fetch.
  useEffect(() => setOrigin(window.location.origin), [])

  const resolutionRule = ruleOverride ?? deriveRule(question)
  const imageUrl = useMemo(() => (origin ? tileUrl(origin, category) : ''), [origin, category])

  // A category change resets the source, but only while the host has not edited
  // it into something specific. Editing the rule survives a category change,
  // because the rule is about the question and the source is about the sport.
  useEffect(() => {
    setSource(DEFAULT_SOURCE[category] ?? DEFAULT_SOURCE.other!)
  }, [category])

  const fetchable = isPublicOrigin(origin)

  const flow = useCreateFlow({
    connection,
    signer,
    wallet,
    circleId,
    sessionId,
    title: question.trim(),
    category,
    resolutionRule,
    sourcesOfTruth: [source.trim()].filter((s) => s.length > 0),
    imageUrl,
    onSettled: onCreated,
  })

  const { state } = flow
  const ready = question.trim().length > 3
  const inFlight =
    state.stage === 'building' ||
    state.stage === 'signing' ||
    state.stage === 'broadcasting' ||
    state.stage === 'confirming' ||
    state.stage === 'registering'

  // Quote as soon as there is a real question, because the fee is the thing the
  // host needs to see before they decide and it cannot be seen before Panta
  // answers.
  //
  // DEBOUNCED, and not as a nicety. Quotes are rate-limited at 30 per 60s per
  // API key — a key shared by every user of the deployment, not per person. An
  // undebounced effect keyed on the question would fire once per keystroke, so
  // typing "Will there be a goal before half time?" would spend 39 of the
  // deployment's 30 quotes and start failing other people's markets for a
  // background rate limit the user cannot see.
  useEffect(() => {
    if (!ready || !origin || !fetchable) return
    const timer = setTimeout(() => {
      void flow.quote()
    }, QUOTE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, origin, question, category, fetchable])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget && !inFlight) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Call a new market"
        className="flex max-h-[92vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-[var(--radius)] border-t border-[var(--border)] bg-[var(--surface-raised)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-[var(--radius)] sm:border"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Call a new market</h2>
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              One yes/no question the room can take a position on.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={inFlight}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded p-2 text-[var(--text-faint)] disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        {state.stage !== 'done' && (
          <>
            {/* ── The question ───────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <label htmlFor="create-question" className="text-xs text-[var(--text-muted)]">
                Question
              </label>
              <textarea
                id="create-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={200}
                rows={2}
                disabled={flow.busy}
                placeholder="Will there be a goal before half time?"
                className="resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
              />
            </div>

            {/* ── The category, which is also the tile ──────────────────── */}
            <div className="flex flex-col gap-2">
              <span className="text-xs text-[var(--text-muted)]">Category</span>
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    disabled={flow.busy}
                    aria-pressed={c === category}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs capitalize disabled:opacity-40 ${
                      c === category
                        ? 'border-[var(--accent)] font-semibold'
                        : 'border-[var(--border)] text-[var(--text-muted)]'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={tileUrl(origin || 'https://invalid.local', c)}
                      alt=""
                      width={16}
                      height={16}
                      className="size-4 rounded-full"
                    />
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* ── The fee ───────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              {state.stage === 'quoting' || state.stage === 'editing' ? (
                <p className="text-sm text-[var(--text-muted)]">Asking Panta what this costs…</p>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-[var(--text-muted)]">Creation fee</span>
                    <span className="font-mono text-lg font-semibold">
                      {usdc(Number(state.buildFee ?? state.quote?.paymentUsdc))}
                    </span>
                  </div>
                  {state.duplicateOf && (
                    <p className="text-xs text-[var(--text-muted)]">
                      This question is already open in this session. Close this and the market is
                      already there — creating another would cost a second fee.
                    </p>
                  )}
                  {state.feeChanged && (
                    <p className="rounded-[var(--radius-sm)] bg-[var(--warn-wash)] p-2 text-xs text-[var(--warn)]">
                      The fee changed between asking and building. It is shown above. Nothing has
                      been charged. Tap again to pay this one.
                    </p>
                  )}
                  {state.error && <p className="text-xs text-[var(--danger)]">{state.error}</p>}
                </>
              )}
            </div>

            {/* ── Details: the rule and the source ─────────────────────── */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                className="self-start text-xs text-[var(--text-muted)] underline"
              >
                {showDetails ? 'Hide resolution details' : 'How does this resolve?'}
              </button>
              {showDetails && (
                <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
                  <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                    Resolution rule
                    <textarea
                      value={resolutionRule}
                      onChange={(e) => setRuleOverride(e.target.value)}
                      rows={4}
                      disabled={flow.busy}
                      className="resize-none rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs leading-relaxed"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                    Source of truth
                    <input
                      type="text"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      disabled={flow.busy}
                      className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* ── The localhost wall ───────────────────────────────────── */}
            {!fetchable && origin !== '' && (
              <p role="alert" className="rounded-[var(--radius-sm)] bg-[var(--warn-wash)] p-2 text-xs text-[var(--warn)]">
                Market images have to be fetchable from a public HTTPS address, and Panta fetches
                them itself. This build is running on <code>{origin}</code>, so a market created
                here would be rejected after you paid the fee. Deploy first.
              </p>
            )}

            <button
              type="button"
              onClick={() => {
                // feeChanged is checked FIRST, not as an `else if` after
                // `stage === 'quoted'`. A fee change leaves the stage at 'quoted'
                // — there is nothing left to sign, so `confirm` is not the
                // action — and an `else if` ordering meant this branch was
                // unreachable: the button said "accept the new fee" and tapped
                // into a no-op.
                if (state.feeChanged) void flow.requote()
                else if (state.stage === 'quoted') void flow.confirm()
                else if (state.stage === 'error') void flow.requote()
              }}
              disabled={!ready || !fetchable || flow.busy || !!state.duplicateOf}
              className="min-h-[2.75rem] rounded-[var(--radius)] bg-[var(--accent)] font-semibold text-[var(--surface)] disabled:opacity-40"
            >
              {buttonLabel(state.stage, ready, fetchable, state.feeChanged)}
            </button>
          </>
        )}

        {/* ── In flight ─────────────────────────────────────────────────── */}
        {STAGE_COPY[state.stage] && (
          <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-sm">{STAGE_COPY[state.stage]}</p>
            {state.signature && <TxLink signature={state.signature} className="text-xs" />}
          </div>
        )}

        {/* ── Done ──────────────────────────────────────────────────────── */}
        {state.stage === 'done' && (
          <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--yes)]/30 bg-[var(--yes-wash)] p-3">
            <p className="text-sm font-medium text-[var(--yes-strong)]">Market is live</p>
            <p className="text-xs text-[var(--text-muted)]">
              {usdc(Number(state.buildFee))} paid. It is in the room and tradable now.
            </p>
            {state.signature && <TxLink signature={state.signature} className="text-xs" />}
          </div>
        )}

        {state.stage === 'done' && (
          <button
            type="button"
            onClick={onClose}
            className="min-h-[2.75rem] rounded-[var(--radius)] border border-[var(--border)] font-semibold"
          >
            Done
          </button>
        )}

        {state.stage === 'error' && !STAGE_COPY[state.stage] && (
          <p className="text-sm text-[var(--danger)]">{state.error ?? 'Something went wrong.'}</p>
        )}
      </div>
    </div>
  )
}

function buttonLabel(
  stage: CreateStage,
  ready: boolean,
  fetchable: boolean,
  feeChanged: boolean,
): string {
  if (!fetchable) return 'Needs a public address'
  if (!ready) return 'Ask a question'
  if (stage === 'quoting') return 'Asking Panta…'
  if (stage === 'building') return 'Building…'
  if (stage === 'signing') return 'Check your wallet…'
  if (stage === 'broadcasting') return 'Sending…'
  if (stage === 'confirming') return 'Confirming…'
  if (stage === 'registering') return 'Registering…'
  if (stage === 'error') return 'Try again'
  // Not "accept" — nothing is being accepted. The createId is spent, so the tap
  // asks Panta for a fresh quote, and it is the NEW number on screen that a
  // second tap would pay. Promising acceptance of a number that cannot be spent
  // would be the lie.
  if (feeChanged) return 'Check the new fee'
  return 'Create the market'
}
