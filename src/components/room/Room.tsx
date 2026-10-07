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
import { Trophy, Users, Waveform } from '@phosphor-icons/react'
import { StalenessStamp, PoweredByPanta, TxLink } from '@/components/compliance/PantaCompliance'
import { BuySheet } from '@/components/trade/BuySheet'
import { SessionBar } from '@/components/room/SessionBar'
import { CreateSheet } from '@/components/trade/CreateSheet'
import { apiGet, ApiError } from '@/lib/client/api'
import { clientConfig } from '@/lib/client/config'
import {
  asPrice,
  memberName,
  pricePercent,
  usdc,
  usdcSigned,
  usdcCompact,
  type PantaPrice,
} from '@/lib/format'
import { useConnection } from '@/lib/wallet/useWallet'
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
  // `status` is the union the server actually returns, not `string`. Widening it
  // to `string` here pushed the narrowing into SessionBar's props, where it had
  // to be re-asserted — and a status that is `string` at the boundary is a status
  // nobody checked.
  session: { id: string; title: string; startedAt: string; endsAt: string; status: 'active' | 'ended' } | null
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

export function Room({
  circleId,
  categories,
}: {
  circleId: string
  /** From the server, so there is one list. See app/c/[circleId]/page.tsx. */
  categories: readonly string[]
}) {
  const { connected } = useWalletContext()
  const connection = useConnection(clientConfig.rpcUrl)
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Which market's buy sheet is open, if any. Held as an id + side rather than
  // a component ref, so a poll landing mid-buy cannot close the sheet the user
  // is signing in: the market object changes underneath it on every poll, and
  // keying the sheet on the object would remount it and throw away the quote.
  const [buying, setBuying] = useState<{ marketId: string; side: 'yes' | 'no' } | null>(null)
  const [creating, setCreating] = useState(false)

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

  // Resolved by id on every render, so the sheet shows the LATEST polled price
  // while still being keyed on the id. Passing the market object down would keep
  // the sheet's headline price frozen at whatever it was when the user tapped.
  const buyTarget = buying ? room.markets.find((m) => m.id === buying.marketId) ?? null : null

  return (
    <div className="flex flex-col gap-8 pb-10">
      <header className="flex flex-col gap-2.5 border-b border-[var(--border)] px-4 pb-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate text-2xl font-bold tracking-tight">{room.circle.name}</h1>
          <div className="flex shrink-0 items-center gap-1.5">
            {live && <span className="chip border-[color-mix(in_oklch,var(--yes)_35%,transparent)] bg-[var(--yes-wash)] font-mono text-[10px] font-bold tracking-[0.14em] text-[var(--yes-strong)]"><span className="live-dot" aria-hidden />LIVE</span>}
            <code className="chip font-mono text-xs tracking-[0.12em]">{room.circle.code}</code>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5">
            <Users size={14} weight="fill" className="text-[var(--text-faint)]" />
            {room.memberCount} in the room
          </span>
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

      <SessionBar
        wallet={connected.address}
        circleId={room.circle.id}
        session={room.session}
        live={live}
        onChanged={() => void load()}
        onCreateMarket={() => setCreating(true)}
      />

      <section aria-labelledby="markets-heading" className="flex flex-col gap-3 px-4">
        <h2 id="markets-heading" className="section-head">
          Markets
          <span className="ml-auto font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--text-faint)]">
            {room.markets.length} open
          </span>
        </h2>
        {room.markets.length === 0 ? (
          <Empty>No markets yet. Start one and it shows up here.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {room.markets.map((market, index) => (
              <li
                key={market.id}
                className="rise"
                style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
              >
                <MarketCard
                  market={market}
                  onBuy={(side) => setBuying({ marketId: market.id, side })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tape-heading" className="flex flex-col gap-2.5 px-4">
        <h2 id="tape-heading" className="section-head">
          <Waveform size={14} weight="fill" className="text-[var(--text-faint)]" />
          The tape
          {live && <span className="live-dot" aria-hidden />}
        </h2>
        {room.tape.length === 0 ? (
          <Empty>No trades yet. First call is yours.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-card)]">
            {room.tape.map((entry) => (
              <li key={entry.signature} className="tape-new flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="truncate font-mono text-xs text-[var(--text-muted)]">
                  {memberName(
                    room.members.find((m) => m.wallet === entry.wallet)?.displayName ?? null,
                    entry.wallet,
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {entry.side && (
                    <span
                      className={`rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${
                        entry.side === 'yes'
                          ? 'bg-[var(--yes-wash)] text-[var(--yes-strong)]'
                          : 'bg-[var(--no-wash)] text-[var(--no-strong)]'
                      }`}
                    >
                      {entry.side.toUpperCase()}
                    </span>
                  )}
                  <span className="font-mono text-xs font-semibold">
                    {usdc(Math.max(entry.yesAmount, entry.noAmount))}
                  </span>
                  <TxLink signature={entry.signature} className="text-xs" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="board-heading" className="flex flex-col gap-2.5 px-4">
        <h2 id="board-heading" className="section-head">
          <Trophy size={14} weight="fill" className="text-[var(--text-faint)]" />
          Scoreboard
        </h2>
        {!room.scoreboard.hasResults ? (
          <Empty>Results land once a market resolves. Nobody is winning yet.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-card)]">
            {room.scoreboard.rows.map((row, index) => (
              <li key={row.userId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span
                  className={`w-6 shrink-0 text-center font-mono text-sm font-semibold tabular-nums ${
                    index === 0 ? 'text-[var(--accent)]' : index < 3 ? 'text-[var(--text-muted)]' : 'text-[var(--text-faint)]'
                  }`}
                >
                  {index + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{memberName(row.displayName, row.wallet)}</span>
                  <span className="font-mono text-[11px] text-[var(--text-faint)]">
                    {row.correct}/{row.resolvedBets} called right
                  </span>
                </div>
                <span
                  className={`shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                    row.netUsdc > 0
                      ? 'text-[var(--yes)]'
                      : row.netUsdc < 0
                        ? 'text-[var(--no)]'
                        : 'text-[var(--text-muted)]'
                  }`}
                >
                  {usdcSigned(row.netUsdc)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && connected && room.session && (
        <CreateSheet
          categories={categories}
          circleId={room.circle.id}
          sessionId={room.session.id}
          connection={connection}
          signer={connected.signer}
          wallet={connected.address}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      )}

      {buying && connected && buyTarget && (
        <BuySheet
          marketId={buyTarget.id}
          marketTitle={buyTarget.title}
          side={buying.side}
          displayedPrice={buying.side === 'yes' ? buyTarget.yesPrice : buyTarget.noPrice}
          circleId={room.circle.id}
          connection={connection}
          signer={connected.signer}
          wallet={connected.address}
          onClose={() => setBuying(null)}
          // A confirmed trade changes the tape, the price, and possibly the
          // scoreboard. Re-reading immediately is what makes the room feel like
          // it reacted rather than that it will update in a moment.
          onSettled={() => void load()}
        />
      )}

      <PoweredByPanta className="!mt-2" />
    </div>
  )
}

function MarketCard({ market, onBuy }: { market: Market; onBuy: (side: 'yes' | 'no') => void }) {
  const yes = asPrice(market.yesPrice)
  const no = asPrice(market.noPrice)

  // A resolved market shows its answer, not a live split. Rendering 1% / 99% on
  // a market that already paid out is not just stale, it is wrong about something
  // that can no longer change.
  if (market.resolved) {
    const won = market.outcome
    return (
      <article className="pulse-card flex flex-col gap-3 p-3">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={market.imageUrl}
            alt=""
            className="size-12 shrink-0 rounded-[var(--radius-sm)] object-cover ring-1 ring-[var(--border)]"
            loading="lazy"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-snug tracking-tight">{market.title}</h3>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-[var(--text-faint)]">
              {market.category} · {market.tradeCount} {market.tradeCount === 1 ? 'trade' : 'trades'}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-faint)]">
            Resolved
          </span>
          <span
            className={`flex items-center gap-1.5 text-sm font-bold capitalize tracking-wide ${
              won === 'yes' ? 'text-[var(--yes-strong)]' : won === 'no' ? 'text-[var(--no-strong)]' : 'text-[var(--text-muted)]'
            }`}
          >
            {won === 'yes' ? <CheckDot tone="yes" /> : won === 'no' ? <CheckDot tone="no" /> : null}
            {won ? won : 'void'}
          </span>
        </div>
      </article>
    )
  }

  const yesPct = pricePercent(yes)
  const noPct = pricePercent(no)

  return (
    <article className="pulse-card flex flex-col gap-3 p-3">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={market.imageUrl}
          alt=""
          className="size-12 shrink-0 rounded-[var(--radius-sm)] object-cover ring-1 ring-[var(--border)]"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight">
            {market.title}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-[var(--text-faint)]">
            {market.category} · {usdcCompact(market.volumeUsdc)} vol · {market.tradeCount}{' '}
            {market.tradeCount === 1 ? 'bet' : 'bets'}
          </p>
        </div>
      </div>

      {/* The board. Two loud sides; the probability bar underneath reads at a
          glance which way the room leans before the numbers do. */}
      <div className="grid grid-cols-2 gap-2">
        <SideButton side="yes" price={yes} onClick={() => onBuy('yes')} />
        <SideButton side="no" price={no} onClick={() => onBuy('no')} />
      </div>

      {yesPct !== null && noPct === null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]" aria-hidden>
          <div className="h-full rounded-full bg-[var(--yes)]" style={{ width: `${yesPct}%` }} />
        </div>
      )}
      {yesPct !== null && noPct !== null && yesPct + noPct > 0 && (
        <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]" aria-hidden>
          <div className="h-full bg-[var(--yes)]" style={{ width: `${yesPct}%` }} />
          <div className="h-full bg-[var(--no)]" style={{ width: `${noPct}%` }} />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {market.pricesAsOf ? (
          <StalenessStamp asOf={market.pricesAsOf} stale={false} className="opacity-70" />
        ) : (
          <span />
        )}
        <span className="flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
          <span className={yesPct !== null && noPct !== null ? 'text-[var(--yes)]' : ''}>
            {yesPct !== null ? `${yesPct}:${noPct ?? '–'}` : '—'}
          </span>
        </span>
      </div>
    </article>
  )
}

function CheckDot({ tone }: { tone: 'yes' | 'no' }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2 rounded-full ${tone === 'yes' ? 'bg-[var(--yes)]' : 'bg-[var(--no)]'}`}
    />
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
 * Opening the buy sheet is NOT the buy. The sheet quotes, shows the real price,
 * and the user confirms. One tap here spends nothing, which is why this can be
 * large and forgiving — the only tap that costs money is one the user has read a
 * number next to.
 */
function SideButton({
  side,
  price,
  onClick,
}: {
  side: 'yes' | 'no'
  price: PantaPrice | null
  onClick: () => void
}) {
  const isYes = side === 'yes'
  const pct = pricePercent(price)
  return (
    <button
      type="button"
      onClick={onClick}
      // Buy YES / Buy NO. On stage this is the tap that proves the whole thing.
      aria-label={`Buy ${side.toUpperCase()}`}
      className={`btn ${isYes ? 'btn-yes' : 'btn-no'} flex-col gap-1 px-3 py-2.5`}
    >
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">
        {side.toUpperCase()}
      </span>
      <span className="text-[1.5rem] font-bold leading-none tracking-tight">
        {pct === null ? '—' : pct}
        <span className="ml-px text-[0.6em] font-semibold opacity-70">%</span>
      </span>
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-raised)]/60 px-3 py-4 text-sm text-[var(--text-faint)]">
      {children}
    </p>
  )
}