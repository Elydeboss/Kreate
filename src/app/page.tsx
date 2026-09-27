/**
 * Foundation status page.
 *
 * This is NOT the product UI. It exists so there is a real, runnable smoke-test
 * target for the Panta integration layer: it exercises env validation and
 * reports which subsystem is wired. It gets replaced by the actual landing page
 * (connect wallet -> create or join a Circle) in the next task.
 */

import { stats as cacheStats } from '@/lib/panta/cache'
import { snapshot as limiterSnapshot, type RateFamily } from '@/lib/panta/limiter'
import { breakerState } from '@/lib/panta/breaker'
import { PANTA_BASE_URL } from '@/lib/server/env'
import { dbStatsPlaceholder } from '@/lib/db/stats'

export const dynamic = 'force-dynamic'

function Row({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'good' | 'warn' }) {
  const color = tone === 'good' ? 'text-[var(--yes)]' : tone === 'warn' ? 'text-[var(--warn)]' : 'text-[var(--text)]'
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] py-2 last:border-0">
      <span className="text-sm text-[var(--text-muted)]">{label}</span>
      <span className={`font-mono text-sm ${color}`}>{value}</span>
    </div>
  )
}

export default function FoundationPage() {
  const cache = cacheStats()
  const limiter = limiterSnapshot()
  const breaker = breakerState('panta')
  const db = dbStatsPlaceholder()

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Pulse</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Social prediction markets for the moments your group is already arguing about.
        </p>
      </header>

      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">
          Foundation
        </h2>
        <Row label="Panta base URL" value={PANTA_BASE_URL} />
        <Row label="Rate limiter" value="in-process token buckets" tone="good" />
        <Row label="Cache" value={`${cache.keys} keys, ${cache.fresh} fresh, ${cache.stale} stale`} />
        <Row label="Circuit breaker" value={breaker.state} tone={breaker.state === 'closed' ? 'good' : 'warn'} />
        <Row label="Database" value={db.ok ? 'reachable' : 'not configured'} tone={db.ok ? 'good' : 'warn'} />
      </section>

      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">
          Panta rate budget
        </h2>
        <p className="mb-3 text-xs text-[var(--text-faint)]">
          Per API key, shared by every Pulse user. <code>build</code> at 20/min is the binding constraint.
        </p>
        {(Object.entries(limiter) as Array<[string, { capacity: number; remaining: number }]>).map(
          ([family, state]) => (
            <Row
              key={family}
              label={family}
              value={`${state.remaining}/${state.capacity}`}
              tone={state.remaining === 0 ? 'warn' : 'default'}
            />
          ),
        )}
      </section>

      <section className="rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-wash)] p-4">
        <h2 className="mb-1 text-sm font-medium">Product UI not built yet</h2>
        <p className="text-sm text-[var(--text-muted)]">
          This page is a smoke test for the Panta integration layer. Wallet connect, Circle,
          Live Session, Create, Buy and Claim are the next tasks in{' '}
          <code>docs/ARCHITECTURE.md</code> §10.
        </p>
      </section>

      <footer className="mt-auto pt-4 text-center text-xs text-[var(--text-faint)]">
        Powered by{' '}
        <a
          href="https://panta.market"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-2"
        >
          Panta
        </a>
      </footer>
    </main>
  )
}
