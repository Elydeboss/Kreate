'use client'

/**
 * The session bar: start, end, and the one button that creates a market.
 *
 * This component exists because a session is the room's precondition for
 * everything else. Every market inherits its `startTime` and `endTime` from the
 * session it belongs to, and that inheritance is the only reason a mid-match
 * market is possible at all — `startTime` has to be in the past, and the session's
 * own start is the only timestamp that reliably is. So with no session there is
 * no market, no trade, no tape, and no scoreboard. The room is not "empty" without
 * one, it is unreachable.
 *
 * WHICH MEANS THE START BUTTON IS NOT A SETTING. It is the front door, and it is
 * the first thing on screen when there is no session — not tucked behind a menu,
 * not behind a "new" affordance that also does other things. A watch party that
 * cannot start is a group chat with a price column.
 *
 * DURATION IS NOT ASKED FOR. Two hours is a football match plus the halftime
 * conversation, and the one case where a shorter session is genuinely wanted —
 * someone watching a single set — is not worth a picker. The session ends itself
 * when its time is up, and the scoreboard appears.
 *
 * WHO CAN END IT: anyone in the circle. Not because ending is destructive — it
 * is reversible in the sense that another can be started immediately — but
 * because a session whose end requires an admin is a session that outlives the
 * watch party, and a market that outlives the room breaks the scoreboard's
 * boundary. The server still checks membership; this is about not making people
 * ask permission for the obvious thing.
 */

import { useState } from 'react'
import { ArrowRight, Plus, X } from '@phosphor-icons/react'
import { ApiError, endSession, startSession, newIdempotencyKey } from '@/lib/client/api'
import { countdown } from '@/lib/format'

export interface SessionBarProps {
  wallet: string
  circleId: string
  session: {
    id: string
    title: string
    status: 'active' | 'ended'
    endsAt: string
  } | null
  live: boolean
  /** Re-read the room. The room is the only thing that knows about markets. */
  onChanged: () => void
  onCreateMarket: () => void
}

export function SessionBar({
  wallet,
  circleId,
  session,
  live,
  onChanged,
  onCreateMarket,
}: SessionBarProps) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── No session yet, or the last one is over ───────────────────────────────
  if (!session || session.status === 'ended') {
    return (
      <section className="flex flex-col gap-3 px-4">
        {session && (
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
            Last session ended · <span className="normal-case text-[var(--text-muted)]">{session.title}</span>
          </p>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="session-title" className="label">
            What are you watching?
          </label>
          <input
            id="session-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Arsenal vs Chelsea"
            maxLength={120}
            disabled={busy}
            className="input"
          />
        </div>

        <button
          type="button"
          onClick={() => void go(start)}
          disabled={busy}
          className="btn btn-primary w-full"
        >
          {busy ? 'Starting…' : 'Start the watch party'}
          {!busy && <ArrowRight size={16} weight="bold" />}
        </button>

        {error && (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
      </section>
    )
  }

  // ── Live ──────────────────────────────────────────────────────────────────
  const remainingMs = new Date(session.endsAt).getTime() - Date.now()
  const underTen = live && remainingMs <= 60_000

  return (
    <section className="flex flex-col gap-3 px-4">
      <div className="pulse-card flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {live && <span className="live-dot" aria-hidden />}
            <h2 className="truncate text-lg font-bold tracking-tight">{session.title}</h2>
          </div>
          <span
            className={`shrink-0 font-mono text-xl font-bold tabular-nums tracking-tight ${
              live ? (underTen ? 'text-[var(--warn)]' : 'text-[var(--text)]') : 'text-[var(--text-faint)]'
            }`}
          >
            {live ? countdown(remainingMs) : 'Ended'}
          </span>
        </div>

        {/* The primary action while live. Creating a market is the thing a host
            does, and burying it is why a watch party sits there with nothing to
            bet on. */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCreateMarket}
            disabled={!live}
            className="btn btn-primary flex-1"
          >
            <Plus size={16} weight="bold" />
            {live ? 'Call a market' : 'Session over'}
          </button>
          <button
            type="button"
            onClick={() => void go(end)}
            disabled={busy}
            aria-label="End the session"
            title="End the session"
            className="btn btn-ghost shrink-0 px-3"
          >
            <X size={16} weight="bold" />
            <span className="hidden sm:inline">End</span>
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  )

  /**
   * One submit path for both actions.
   *
   * The idempotency key is minted inside the tap, in `start` and `end`, and not
   * held in state across renders. That is the point of it: a key regenerated
   * when the component re-renders protects nothing, and this is the case it
   * exists for — a host on café wifi tapping "end" twice because the first tap
   * changed nothing on screen fast enough to notice.
   *
   * Declared after the early returns, which is legal because function
   * declarations hoist. It keeps the two JSX branches above free of a `busy`
   * try/catch each.
   */
  async function go(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.')
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    await startSession(wallet, { circleId, title: title.trim() || 'Watch party' }, newIdempotencyKey())
  }

  async function end() {
    if (!session) return
    await endSession(wallet, session.id, newIdempotencyKey())
  }
}