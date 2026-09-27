'use client'

/**
 * The buy sheet: quote, confirm, sign, done.
 *
 * The sheet exists because the buy has a decision in it that a single tap cannot
 * honestly make. A tap that opens a wallet popup has already committed the user
 * to a price they cannot see. A tap that quotes nothing spends a round trip for
 * a number that might be 40 seconds old by the time they read it.
 *
 * SO THE ORDER IS: quote first, show the number, then one tap that builds,
 * signs, and broadcasts. Two taps total, and the second one is the one the user
 * means.
 *
 * WHAT THE SHEET REFUSES TO DO:
 *
 *   - It never says "confirmed" before the chain says so.
 *   - It never retries the sign. A second wallet popup against a 60-second
 *     blockhash either lands or does not, and an auto-retry against a moving
 *     price fills people at a number they never saw.
 *   - It never shows an error for a wallet rejection. The user closing their own
 *     wallet is not a failure and should not be styled like one.
 */

import { useEffect, useState } from 'react'
import { useBuyFlow, type BuyStage } from '@/lib/trade/useBuyFlow'
import { asPrice, priceLabel, usdc, usdcCompact } from '@/lib/format'
import { TxLink } from '@/components/compliance/PantaCompliance'
import type { OrderSide } from '@/lib/panta/types'
import type { Connection } from '@solana/web3.js'
import type { TxSigner } from '@/lib/tx/instructionTx'

/** Presets sized for a phone wallet. Deliberately small; this is USDC, real money. */
const PRESETS = ['1', '5', '20', '100'] as const

/** Max slippage we will accept without the user editing it. 300bps = 3%. */
const DEFAULT_SLIPPAGE_BPS = 300

export interface BuySheetProps {
  marketId: string
  marketTitle: string
  side: OrderSide
  /** The price shown on the button, for comparison against the real quote. */
  displayedPrice: number | null
  circleId: string
  connection: Connection
  signer: TxSigner | null
  wallet: string
  onClose: () => void
  onSettled: () => void
}

export function BuySheet(props: BuySheetProps) {
  const { marketId, marketTitle, side, circleId, connection, signer, wallet, onClose, onSettled } = props

  const [amount, setAmount] = useState<string>('5')
  const flow = useBuyFlow({
    connection,
    signer,
    wallet,
    circleId,
    pulseMarketId: marketId,
    side,
    amountUsdc: amount,
    maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
    onSettled,
  })

  const { state } = flow

  // Quote as soon as the sheet is open and the amount is sane. There is no point
  // showing a sheet with a button that has nothing behind it, and the 90-second
  // quote clock is already running by the time they read the title.
  //
  // The else branch matters as much as the if. Clearing the amount field must
  // take the price with it: a live quote next to an empty input is the same
  // failure as a live quote next to a different number, and the button is only
  // one tap from spending it.
  useEffect(() => {
    if (Number(amount) > 0) void flow.quote()
    else flow.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, marketId, side])

  const busy = BUSY.has(state.stage)
  const amountNum = Number(amount)
  const amountValid = Number.isFinite(amountNum) && amountNum > 0

  // Price drift between the button and the quote. Shown so a user who watched a
  // price move understands why the number changed, rather than assuming a bug.
  const drift = state.effectiveAvgPrice
    ? Number(state.effectiveAvgPrice) - (props.displayedPrice ?? Number(state.effectiveAvgPrice))
    : 0
  const drifted = Math.abs(drift) >= 0.01

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        // Tapping the scrim closes, but only when nothing is in flight. Closing
        // mid-sign would abandon an order the user already approved.
        if (e.target === e.currentTarget && !IN_FLIGHT.has(state.stage)) {
          flow.cancel()
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Buy ${side.toUpperCase()}`}
        className="flex max-h-[92vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-[var(--radius)] border-t border-[var(--border)] bg-[var(--surface-raised)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-[var(--radius)] sm:border"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className={`text-xs font-semibold uppercase tracking-wide ${
                side === 'yes' ? 'text-[var(--yes)]' : 'text-[var(--no)]'
              }`}
            >
              Buy {side.toUpperCase()}
            </p>
            <h2 className="mt-0.5 text-sm font-medium leading-snug">{marketTitle}</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              flow.cancel()
              onClose()
            }}
            disabled={IN_FLIGHT.has(state.stage)}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded p-2 text-[var(--text-faint)] disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        {/* ── Amount ─────────────────────────────────────────────────────── */}
        {state.stage !== 'done' && (
          <div className="flex flex-col gap-2">
            <label htmlFor="buy-amount" className="text-xs text-[var(--text-muted)]">
              Amount
            </label>
            <div className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-3">
              <span className="text-sm text-[var(--text-faint)]">$</span>
              <input
                id="buy-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
                className="min-w-0 flex-1 bg-transparent py-3 font-mono text-lg outline-none"
              />
              <span className="text-xs text-[var(--text-faint)]">USDC</span>
            </div>
            <div className="flex gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmount(preset)}
                  disabled={busy}
                  className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] py-2 text-xs font-medium disabled:opacity-40"
                >
                  ${preset}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--text-faint)]">
              Up to {DEFAULT_SLIPPAGE_BPS / 100}% price movement. This is real money and
              it is yours either way.
            </p>
          </div>
        )}

        {/* ── The quote ───────────────────────────────────────────────────── */}
        {(state.stage === 'quoting' || state.stage === 'quoted' || state.stage === 'building') && (
          <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-3">
            {state.stage === 'quoting' && <p className="text-sm text-[var(--text-muted)]">Pricing…</p>}

            {state.stage !== 'quoting' && state.quote && (
              <>
                <Row label="Price" value={priceLabel(asPrice(Number(state.effectiveAvgPrice)))} />
                <Row label="Shares" value={usdcCompact(Number(state.effectiveShares))} />
                <Row label="Fee" value={usdc(Number(state.feeUsdc))} />
                {state.quoteSecondsLeft !== null && (
                  <p
                    className={`text-xs ${
                      state.quoteSecondsLeft <= 20
                        ? 'font-medium text-[var(--warn)]'
                        : 'text-[var(--text-faint)]'
                    }`}
                  >
                    Price held for {state.quoteSecondsLeft}s
                  </p>
                )}
              </>
            )}

            {state.requoted && (
              <p className="rounded-[var(--radius-sm)] bg-[var(--warn-wash)] p-2 text-xs text-[var(--warn)]">
                The price moved while you were deciding. These are the new numbers.
                {drifted && drift < 0 ? ' It got cheaper for you.' : ''}
              </p>
            )}

            {state.cancelled && (
              <p className="text-xs text-[var(--text-faint)]">Cancelled. No funds moved.</p>
            )}

            {state.error && <p className="text-xs text-[var(--danger)]">{state.error}</p>}
          </div>
        )}

        {/* ── In flight ───────────────────────────────────────────────────── */}
        {(state.stage === 'signing' || state.stage === 'broadcasting' || state.stage === 'confirming') && (
          <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-3">
            <p className="text-sm">{STAGE_COPY[state.stage]}</p>
            {state.signature && <TxLink signature={state.signature} className="text-xs" />}
          </div>
        )}

        {/* ── Done ────────────────────────────────────────────────────────── */}
        {state.stage === 'done' && (
          <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--yes)]/30 bg-[var(--yes-wash)] p-3">
            <p className="text-sm font-medium text-[var(--yes-strong)]">Bought {side.toUpperCase()}</p>
            {state.signature && <TxLink signature={state.signature} className="text-xs" />}
          </div>
        )}

        {state.stage === 'error' && !busy && (
          <p className="text-sm text-[var(--danger)]">
            {state.error ?? 'Something went wrong.'}
          </p>
        )}

        {/* ── The button ──────────────────────────────────────────────────── */}
        {state.stage !== 'done' && (
          <button
            type="button"
            // The one tap the user means. Everything expensive happens inside it.
            onClick={() => {
              // Only ever confirm from a state where a live quote exists. An
              // expired quote must go back through `quote`, not through
              // `confirm`, because `confirm` builds on a quoteId that no longer
              // exists and the user would see a build error instead of a price.
              if (state.stage === 'quoted') void flow.confirm()
              else if (state.stage === 'error') void flow.quote()
            }}
            disabled={!amountValid || busy || (state.stage !== 'quoted' && state.stage !== 'error')}
            className={`min-h-[2.75rem] rounded-[var(--radius)] font-semibold disabled:opacity-50 ${
              side === 'yes'
                ? 'bg-[var(--yes-wash)] text-[var(--yes-strong)]'
                : 'bg-[var(--no-wash)] text-[var(--no-strong)]'
            }`}
          >
            {stageLabel(state.stage, side, amountValid)}
          </button>
        )}

        {state.stage === 'done' && (
          <button
            type="button"
            onClick={() => {
              flow.reset()
              onClose()
            }}
            className="min-h-[2.75rem] rounded-[var(--radius)] border border-[var(--border)] font-semibold"
          >
            Done
          </button>
        )}

        {/* A quote that died under the user needs a way back, and it must not be
            the same button that spends money. */}
        {state.stage === 'quoted' && state.error && (
          <button
            type="button"
            onClick={() => void flow.quote()}
            className="text-xs text-[var(--text-muted)] underline"
          >
            Get a fresh price
          </button>
        )}
      </div>
    </div>
  )
}

const BUSY: ReadonlySet<BuyStage> = new Set([
  'quoting',
  'building',
  'signing',
  'broadcasting',
  'confirming',
])

/**
 * Stages where the transaction is out of our hands. The scrim and the close
 * button both stop working here: the user already approved, the bytes are in
 * flight, and a sheet that vanishes mid-confirmation reads as a failure and
 * invites a second tap that spends twice.
 */
const IN_FLIGHT: ReadonlySet<BuyStage> = new Set(['signing', 'broadcasting', 'confirming'])

const STAGE_COPY: Partial<Record<BuyStage, string>> = {
  signing: 'Approve in your wallet…',
  broadcasting: 'Sending…',
  confirming: 'Confirming on chain…',
}

function stageLabel(stage: BuyStage, side: OrderSide, amountValid: boolean): string {
  if (stage === 'quoting') return 'Pricing…'
  if (stage === 'building') return 'Building…'
  if (stage === 'signing') return 'Check your wallet…'
  if (stage === 'broadcasting') return 'Sending…'
  if (stage === 'confirming') return 'Confirming…'
  if (stage === 'error') return 'Try again'
  if (!amountValid) return 'Enter an amount'
  // The button names the side, the row above it names the number. A button that
  // said "Buy YES at 62¢" would be the better label and the worse one: the price
  // it carries is the one from the last poll, not the one that will execute.
  return `Buy ${side.toUpperCase()}`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}
