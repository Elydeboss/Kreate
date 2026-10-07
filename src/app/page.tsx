/**
 * Landing page.
 *
 * Connect a wallet, then start or join a circle. That is the whole funnel, and it
 * is deliberately two steps: a wallet is the account, and the only question left
 * is which side of the invite you are on.
 *
 * Server-rendered so the page is meaningful before hydration — a demo opened on
 * hotel wifi with a cold JS bundle should still say what Pulse is. The only
 * interactive part is <CircleSetup>, which needs the wallet connection.
 */

import { Suspense } from 'react'
import { ConnectButton } from '@/components/wallet/ConnectButton'
import { CircleSetup } from '@/components/landing/CircleSetup'
import { PoweredByPanta } from '@/components/compliance/PantaCompliance'

const PRINCIPLES = [
  'Non-custodial. Your wallet signs, your funds move.',
  'Real markets, real prices, settled on Solana.',
  'Built for a phone and a bad connection.',
] as const

export default function LandingPage() {
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-lg flex-col gap-10 px-4 pb-10 pt-4">
      <div className="landing-bg" aria-hidden />
      <div className="landing-edge" aria-hidden />

      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-xl font-bold tracking-tighter">Pulse</span>
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--text-faint)] sm:inline">
            live prediction markets
          </span>
        </div>
        <ConnectButton />
      </header>

      <section className="flex flex-col gap-5 pt-6">
        <h1 className="text-4xl font-bold leading-[1.05] tracking-tighter">
          The argument your group is already having,
          <br className="hidden sm:block" /> with{' '}
          <span className="text-[var(--accent)]">money on it.</span>
        </h1>
        <p className="max-w-[36ch] text-base leading-relaxed text-[var(--text-muted)]">
          Start a circle, share the code, and let everyone call the next play in real USDC.
          Prices move as the room takes positions, and you can watch the tape fill up.
        </p>
      </section>

      <section>
        <Suspense fallback={<div className="h-40" />}>
          <CircleSetup />
        </Suspense>
      </section>

      <footer className="mt-auto flex flex-col gap-5 pt-8">
        <ul className="flex flex-col gap-2.5">
          {PRINCIPLES.map((line, index) => (
            <li key={line} className="flex items-baseline gap-3 text-sm text-[var(--text-muted)]">
              <span className="font-mono text-[11px] font-semibold tracking-widest text-[var(--text-faint)]">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <PoweredByPanta />
      </footer>
    </main>
  )
}