'use client'

/**
 * The room: markets, tape, scoreboard, members.
 *
 * Mobile-first and one-handed, because a watch party is watched on a phone while
 * the actual thing being predicted is happening somewhere else. Layout priority
 * is therefore: what the room is calling, what it costs, what happened.
 *
 * This component owns no market data. It reads the room endpoint, which is a
 * single snapshot per poll — see the route for why it is one call and not six.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { StalenessStamp, PoweredByPanta, TxLink } from '@/components/compliance/PantaCompliance'
import { apiGet, ApiError } from '@/lib/client/api'
import { asPrice, memberName, priceLabel, usdc, usdcSigned, usdcCompact, countdown, type PantaPrice } from '@/lib/format'
import { useWalletContext } from '@/lib/wallet/WalletProvider'

// ── Wire types, mirroring the room route's response ─────────────────────────

interface Member {
  userId: string
  wallet: string
  displayName: string | null
}

interface Market {
  id: string
  pantaMarketId: string
  title: string
  category: string
  imageUrl: string
  phase: string | null
  resolved: boolean
  outcome: 'yes' | 'no' | null
  yesPrice: number | null
  noPrice: number | null
  volumeUsdc: number | null
  pricesAsOf: string | null
  tradeCount: number
}

interface TapeEntry {
  signature: string
  wallet: string
  side: 'yes' | 'no' | null
  yesAmount: number
  noAmount: number
  blockTime: number | null
}

interface ScoreRow {
  userId: string
  wallet: string
  displayName: string | null
  bets: number
  resolvedBets: number
  correct: number
  wrong: number
  netUsdc: number
}

interface RoomSnapshot {
  circle: { id: string; code: string; name: string }
  session: { id: string; title: string; startedAt: string; endsAt: string; status: string } | null
  members: Member[]
  memberCount: number
  markets: Market[]
  tape: TapeEntry[]
  scoreboard: { rows: ScoreRow[]; hasResults: boolean }
  staleness: {
    pricesAsOf: string | null
    stale: boolean
    degraded: string | null
    ttlMs: number
    deferred: number
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

/**
 * Poll cadence. Derived from the server's own answer, not guessed.
 *
 * The route ships `ttlMs` — the cadence the shared rate budget actually allows
 * for this room's market count. Polling faster than that spends nothing extra,
 * because the cache collapses duplicate reads, but it does burn a request and a
 * database round-trip per user per interval. Polling slower would show prices
 * older than the budget requires, which is a worse trade.
 */
function pollInterval(ttlMs: number): number {
  return Math.max(3_000, Math.min(20_000, Math.round(ttlMs * 1.5)))
}

export function Room({ circleId }: { circleId: string }) {
  const { connected } = useWalletContext()
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Survives a hidden tab. Polling continues on a phone that has been pocketed,
  // which is where most of a watch party actually happens.
  const mounted = useRef(true)

  const load = useCallback(async () => {
    if (!connected) return
    try {
      const next = await apiGet<RoomSnapshot>(`/api/circles/${circleId}/room`, connected.address)
      if (!mounted.current) return
      setRoom(next)
      setError(null)
    } catch (err) {
      if (!mounted.current) return
      // A failed poll must NOT blank a room that is already on screen. The prices
      // stay, with the staleness stamp now telling the truth that they are old.
      setError(err instanceof ApiError ? err.message : 'Lost connection.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [circleId, connected])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  useEffect(() => {
    if (!room) return
    const id = setInterval(() => void load(), pollInterval(room.staleness.ttlMs))
    return () => clearInterval(id)
  }, [room, load])

  if (!connected) {
    return <p className="p-4 text-sm text-[var(--text-muted)]">Connect a wallet to open this room.</p>
  }
  if (loading && !room) {
    return <p className="p-4 text-sm text-[var(--text-faint)]">Opening the room…</p>
  }
  if (!room) {
    return (
      <div className="p-4">
        <p className="text-sm text-[var(--text-muted)]">{error ?? 'Could not open this room.'}</p>
      </div>
    )
  }

  const remainingMs = room.session ? new Date(room.session.endsAt).getTime() - Date.now() : 0
  const live = room.session?.status === 'active' && remainingMs > 0

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex flex-col gap-2 border-b border-[var(--border)] px-4 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="truncate text-xl font-semibold tracking-tight">{room.circle.name}</h1>
          <code className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] px-2 py-1 font-mono text-xs">
            {room.circle.code}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>{room.memberCount} in the room</span>
          {room.session && (
            <>
              <span aria-hidden>·</span>
              <span className={live ? 'font-mono text-[var(--yes)]' : 'font-mono'}>
                {live ? countdown(remainingMs) : 'Ended'}
              </span>
            </>
          )}
          {room.staleness.pricesAsOf && (
            <StalenessStamp asOf={room.staleness.pricesAsOf} stale={room.staleness.stale} />
          )}
        </div>
        {room.staleness.degraded && (
          <p role="status" className="rounded-[var(--radius-sm)] bg-[var(--warn-wash)] px-2 py-1 text-xs text-[var(--text-muted)]">
            {room.staleness.degraded}
          </p>
        )}
        {error && !room.staleness.degraded && (
          <p role="status" className="text-xs text-[var(--warn)]">
            {error} — showing the last prices received.
          </p>
        )}
      </header>

      <section aria-labelledby="markets-heading" className="flex flex-col gap-3 px-4">
        <h2 id="markets-heading" className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Markets
        </h2>
        {room.markets.length === 0 ? (
          <Empty>No markets yet. Start one and it shows up here.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {room.markets.map((market) => (
              <MarketCard key={market.id} market={market} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tape-heading" className="flex flex-col gap-2 px-4">
        <h2 id="tape-heading" className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          The tape
        </h2>
        {room.tape.length === 0 ? (
          <Empty>No trades yet. First call is yours.</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)]">
            {room.tape.map((entry) => (
              <li key={entry.signature} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="truncate font-mono text-xs text-[var(--text-muted)]">
                  {memberName(
                    room.members.find((m) => m.wallet === entry.wallet)?.displayName ?? null,
                    entry.wallet,
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {entry.side && (
                    <span
                      className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-semibold ${
                        entry.side === 'yes'
                          ? 'bg-[var(--yes-wash)] text-[var(--yes-strong)]'
                          : 'bg-[var(--no-wash)] text-[var(--no-strong)]'
                      }`}
                    >
                      {entry.side.toUpperCase()}
                    </span>
                  )}
                  <span className="font-mono">{usdc(Math.max(entry.yesAmount, entry.noAmount))}</span>
                  <TxLink signature={entry.signature} className="text-xs text-[var(--text-faint)]" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="board-heading" className="flex flex-col gap-2 px-4">
        <h2 id="board-heading" className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Scoreboard
        </h2>
        {!room.scoreboard.hasResults ? (
          <Empty>Results land once a market resolves. Nobody is winning yet.</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)]">
            {room.scoreboard.rows.map((row, index) => (
              <li key={row.userId} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 font-mono text-xs text-[var(--text-faint)]">{index + 1}</span>
                  <span className="truncate">{memberName(row.displayName, row.wallet)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--text-faint)]">
                  <span className="font-mono">
                    {row.correct}/{row.resolvedBets}
                  </span>
                  <span
                    className={`min-w-[4.5rem] text-right font-mono font-semibold ${
                      row.netUsdc > 0
                        ? 'text-[var(--yes)]'
                        : row.netUsdc < 0
                          ? 'text-[var(--no)]'
                          : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {usdcSigned(row.netUsdc)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PoweredByPanta />
    </div>
  )
}

function MarketCard({ market }: { market: Market }) {
  const yes = asPrice(market.yesPrice)
  const no = asPrice(market.noPrice)

  // A resolved market shows its answer, not a live split. Rendering 1% / 99% on
  // a market that already paid out is not just stale, it is wrong about something
  // that can no longer change.
  if (market.resolved) {
    const won = market.outcome
    return (
      <article className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-3">
        <h3 className="text-sm font-medium leading-snug">{market.title}</h3>
        <p className="text-xs text-[var(--text-muted)]">
          Resolved{' '}
          <span
            className={`font-semibold ${
              won === 'yes' ? 'text-[var(--yes)]' : won === 'no' ? 'text-[var(--no)]' : ''
            }`}
          >
            {won ? won.toUpperCase() : ''}
          </span>
        </p>
      </article>
    )
  }

  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-3">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={market.imageUrl}
          alt=""
          className="size-12 shrink-0 rounded-[var(--radius-sm)] object-cover"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium leading-snug">{market.title}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-faint)]">
            {market.category} · {usdcCompact(market.volumeUsdc)} · {market.tradeCount}{' '}
            {market.tradeCount === 1 ? 'trade' : 'trades'}
          </p>
        </div>
      </div>

      <div className="flex items-stretch gap-2">
        <SideButton side="yes" price={yes} />
        <SideButton side="no" price={no} />
      </div>

      {market.pricesAsOf && (
        <div className="flex justify-end">
          <StalenessStamp asOf={market.pricesAsOf} stale={false} className="opacity-70" />
        </div>
      )}
    </article>
  )
}

/**
 * A side, as a 44px-tall button.
 *
 * The price is rendered as text inside the button rather than as the button's
 * colour or width, for two reasons: colour alone is not readable for a
 * colour-blind user, and a width-encoded bar on a 360px screen next to a 44px
 * touch target is worse than a number. The label is the data.
 *
 * The buy action itself lands in the next task; this is the read surface.
 */
function SideButton({ side, price }: { side: 'yes' | 'no'; price: PantaPrice | null }) {
  const isYes = side === 'yes'
  return (
    <button
      type="button"
      // Buy YES / Buy NO. On stage this is the tap that proves the whole thing.
      aria-label={`Buy ${side.toUpperCase()}`}
      className={`flex min-h-[2.75rem] flex-1 items-center justify-between gap-2 rounded-[var(--radius)] px-3 font-semibold ${
        isYes
          ? 'bg-[var(--yes-wash)] text-[var(--yes-strong)]'
          : 'bg-[var(--no-wash)] text-[var(--no-strong)]'
      }`}
    >
      <span>{side.toUpperCase()}</span>
      <span className="font-mono">{priceLabel(price)}</span>
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--text-faint)]">
      {children}
    </p>
  )
}
