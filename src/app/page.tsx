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

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-10 px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">Pulse</span>
        <ConnectButton />
      </header>

      <section className="flex flex-col gap-4 pt-4">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight">
          The argument your group is already having, with money on it.
        </h1>
        <p className="text-base leading-relaxed text-[var(--text-muted)]">
          Start a circle, share the code, and let everyone call the next play in real USDC. Prices
          move as the room takes positions, and you can watch the tape fill up.
        </p>
      </section>

      <section>
        <Suspense fallback={<div className="h-40" />}>
          <CircleSetup />
        </Suspense>
      </section>

      <section className="mt-auto flex flex-col gap-3 pt-8">
        <ul className="flex flex-col gap-2 text-sm text-[var(--text-muted)]">
          <li>Non-custodial. Your wallet signs, your funds move.</li>
          <li>Real markets, real prices, settled on Solana.</li>
          <li>Built for a phone and a bad connection.</li>
        </ul>
        <PoweredByPanta />
      </section>
    </main>
  )
}
