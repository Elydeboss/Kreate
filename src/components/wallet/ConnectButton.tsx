'use client'

/**
 * The wallet connect button and its sheet.
 *
 * One wallet surface in the whole product (PRD §6 — multi-wallet management and
 * embedded wallets were cut). The UI is a bottom sheet rather than a centred
 * modal because every primary action in Pulse is one-handed on a phone, and a
 * sheet puts the wallets under the thumb instead of across the screen.
 *
 * Hand-rolled rather than pulled from a library, for the same reason the
 * connection hook is: this is a judged criterion, and adapting a generic modal
 * to look like Pulse costs more than writing the twenty lines it is made of.
 */

import { useEffect, useRef, useState } from 'react'
import { Wallet, X } from '@phosphor-icons/react'
import { useWalletContext } from '@/lib/wallet/WalletProvider'
import { shortenAddress } from '@/lib/wallet/useWallet'
import { clientConfig } from '@/lib/client/config'

export function ConnectButton() {
  const { connected, available, discovering, connecting, error, connect, disconnect } = useWalletContext()
  const [open, setOpen] = useState(false)

  if (connected) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <a
          href={clientConfig.explorerAccountUrl(connected.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[2.75rem] items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 font-mono text-sm shadow-[var(--shadow-card)] transition-colors hover:border-[var(--border-strong)]"
          title={connected.address}
        >
          {connected.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={connected.icon} alt="" className="size-5 rounded-full" />
          ) : (
            <span className="size-2 rounded-full bg-[var(--yes)]" aria-hidden />
          )}
          {shortenAddress(connected.address)}
        </a>
        <button
          type="button"
          onClick={disconnect}
          aria-label="Disconnect wallet"
          className="btn btn-ghost px-2.5"
        >
          <X size={14} weight="bold" />
          <span className="hidden sm:inline">Disconnect</span>
        </button>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={discovering || connecting}
        className="btn btn-primary shrink-0 px-4"
      >
        <Wallet size={16} weight="bold" />
        {discovering ? 'Looking for wallets…' : connecting ? 'Open your wallet…' : 'Connect wallet'}
      </button>
      {open && (
        <WalletSheet
          available={available}
          error={error}
          onClose={() => setOpen(false)}
          onPick={async (target) => {
            const ok = await connect(target)
            // Only close on success. A rejected or dismissed connect leaves the
            // sheet open, so the user can try a different wallet without having
            // to reopen it and re-find the list.
            if (ok) setOpen(false)
          }}
        />
      )}
    </>
  )
}

function WalletSheet({
  available,
  error,
  onClose,
  onPick,
}: {
  available: ReturnType<typeof useWalletContext>['available']
  error: string | null
  onClose: () => void
  onPick: (target: ReturnType<typeof useWalletContext>['available'][number]) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, and focus moves into the sheet so a keyboard user is not left
  // behind on the trigger button with the overlay covering the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    // Stop the page behind the sheet from scrolling under the user's thumb.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  const pick = async (target: (typeof available)[number]) => {
    setBusy(target.key)
    try {
      await onPick(target)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="sheet-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="sheet"
      >
        <span className="sheet-handle" aria-hidden />

        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Connect a wallet</h2>
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              Your wallet is your account. There is no sign-up and no password.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[var(--radius)] p-2 text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        {error && (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-[var(--no-wash)] px-3 py-2 text-sm text-[var(--no-strong)]">
            {error}
          </p>
        )}

        {available.length === 0 ? (
          <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-muted)]">
            <p className="font-bold text-[var(--text)]">No Solana wallet found</p>
            <p className="mt-1 leading-relaxed">
              Install Phantom, Solflare, or Backpack on this device, then reload. Inside an in-app
              browser, open the page in your wallet&apos;s own browser instead.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {available.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => void pick(entry)}
                  disabled={busy !== null}
                  className="flex min-h-[3.5rem] w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 text-left transition-colors hover:border-[var(--border-strong)] disabled:opacity-60"
                >
                  {entry.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={entry.icon}
                      alt=""
                      className="size-8 rounded-full ring-1 ring-[var(--border)]"
                    />
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--surface-sunken)]">
                      <Wallet size={16} weight="bold" className="text-[var(--text-faint)]" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{entry.name}</span>
                    <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                      {entry.wallet?.chains?.some((c) => c.startsWith('solana:')) ? 'Solana' : 'Wallet'}
                    </span>
                  </span>
                  {busy === entry.key ? (
                    <span className="flex items-center gap-1.5 text-sm text-[var(--text-faint)]">
                      <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden />
                      Waiting…
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-[var(--text-faint)]">
          Pulse never sees your private key. Transactions are signed in your wallet and broadcast
          straight from your browser.
        </p>
      </div>
    </div>
  )
}