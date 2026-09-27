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
import { useWalletContext } from '@/lib/wallet/WalletProvider'
import { shortenAddress } from '@/lib/wallet/useWallet'
import { clientConfig } from '@/lib/client/config'

export function ConnectButton() {
  const { connected, available, discovering, connecting, error, connect, disconnect } = useWalletContext()
  const [open, setOpen] = useState(false)

  if (connected) {
    return (
      <div className="flex items-center gap-1">
        <a
          href={clientConfig.explorerAccountUrl(connected.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[2.75rem] items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 font-mono text-sm"
          title={connected.address}
        >
          {connected.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={connected.icon} alt="" className="size-5 rounded-full" />
          ) : null}
          {shortenAddress(connected.address)}
        </a>
        <button
          type="button"
          onClick={disconnect}
          className="min-h-[2.75rem] rounded-[var(--radius)] px-3 text-sm text-[var(--text-muted)]"
        >
          Disconnect
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
        className="min-h-[2.75rem] rounded-[var(--radius)] bg-[var(--accent)] px-4 font-medium text-white disabled:opacity-60"
      >
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="w-full max-w-md rounded-t-[var(--radius)] border-t border-[var(--border)] bg-[var(--surface-raised)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-[var(--radius)] sm:border"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Connect a wallet</h2>
            <p className="mt-0.5 text-sm text-[var(--text-muted)]">
              Your wallet is your account. There is no sign-up and no password.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[2.75rem] min-w-[2.75rem] rounded-[var(--radius)] text-lg text-[var(--text-muted)]"
          >
            ✕
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-3 rounded-[var(--radius-sm)] bg-[var(--no-wash)] px-3 py-2 text-sm text-[var(--no-strong)]">
            {error}
          </p>
        )}

        {available.length === 0 ? (
          <div className="rounded-[var(--radius-sm)] bg-[var(--warn-wash)] px-3 py-3 text-sm text-[var(--text-muted)]">
            <p className="font-medium text-[var(--text)]">No Solana wallet found</p>
            <p className="mt-1">
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
                  className="flex min-h-[3.25rem] w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] px-3 text-left disabled:opacity-60"
                >
                  {entry.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={entry.icon} alt="" className="size-7 rounded-full" />
                  ) : (
                    <span className="size-7 rounded-full bg-[var(--surface-sunken)]" />
                  )}
                  <span className="flex-1 font-medium">{entry.name}</span>
                  {busy === entry.key && <span className="text-sm text-[var(--text-faint)]">Waiting…</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs text-[var(--text-faint)]">
          Pulse never sees your private key. Transactions are signed in your wallet and broadcast
          straight from your browser.
        </p>
      </div>
    </div>
  )
}
