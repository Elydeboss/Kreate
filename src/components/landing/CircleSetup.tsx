'use client'

/**
 * Landing: connect, then start or join a circle.
 *
 * The whole onboarding flow is one screen with two doors. There is no signup, no
 * email, no password, no profile step — a wallet is the account, and the only
 * question left is whether you are starting a group or joining one. Every extra
 * step between opening the app and being in a room is a step that loses people
 * mid-demo.
 */

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, ArrowUpRight } from '@phosphor-icons/react'
import { useWalletContext } from '@/lib/wallet/WalletProvider'
import {
  ApiError,
  createCircle,
  joinCircle,
  listCircles,
  newIdempotencyKey,
  type Circle,
} from '@/lib/client/api'

type Mode = 'choose' | 'create' | 'join'

export function CircleSetup() {
  const { connected } = useWalletContext()
  const router = useRouter()

  const [mode, setMode] = useState<Mode>('choose')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [circles, setCircles] = useState<Circle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // One key per user intent, held in a ref so a retry reuses it. Generating a
  // fresh key per click is the exact bug idempotency exists to prevent.
  const keyRef = useRef<string | null>(null)
  const currentKey = useCallback(() => {
    if (keyRef.current === null) keyRef.current = newIdempotencyKey()
    return keyRef.current
  }, [])

  const go = useCallback(
    async (fn: (key: string) => Promise<void>) => {
      setBusy(true)
      setError(null)
      try {
        await fn(currentKey())
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
        // Drop the key once the attempt has definitively failed, so the retry is
        // a new intent rather than a replay of a broken one. A request that never
        // reached the server would be safe to replay, but we cannot tell those
        // two cases apart from here, and a fresh key is the safe default.
        keyRef.current = null
      } finally {
        setBusy(false)
      }
    },
    [currentKey],
  )

  if (!connected) {
    return (
      <div className="pulse-card flex flex-col gap-1 p-5">
        <p className="font-semibold">Connect a wallet to get a table.</p>
        <p className="text-sm text-[var(--text-muted)]">
          There is no sign-up. Your wallet is your account, and it already has
          what this needs.
        </p>
      </div>
    )
  }

  // Already in a circle: the only useful thing to offer is the room.
  if (circles && circles.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="label">Your circles</p>
        <ul className="flex flex-col gap-2">
          {circles.map((circle) => (
            <li key={circle.id}>
              <button
                type="button"
                onClick={() => router.push(`/c/${circle.id}`)}
                className="flex min-h-[3.5rem] w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-left shadow-[var(--shadow-card)] transition-colors hover:border-[var(--border-strong)]"
              >
                <span className="truncate font-semibold">{circle.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <code className="font-mono text-xs tracking-wider text-[var(--text-faint)]">
                    {circle.code}
                  </code>
                  <ArrowUpRight size={16} weight="bold" className="text-[var(--text-faint)]" />
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setCircles(null)}
          className="min-h-[2.75rem] self-start px-2 text-sm text-[var(--text-muted)] underline underline-offset-2"
        >
          Join or start another
        </button>
      </div>
    )
  }

  if (mode === 'create') {
    return (
      <Form
        title="Start a circle"
        submitLabel="Create circle"
        busy={busy}
        error={error}
        onCancel={() => setMode('choose')}
        onSubmit={() =>
          go(async (key) => {
            const { circle } = await createCircle(connected.address, name, key)
            router.push(`/c/${circle.id}`)
          })
        }
      >
        <label className="flex flex-col gap-1.5">
          <span className="label">What is it called?</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sunday match"
            maxLength={60}
            autoComplete="off"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="input"
          />
        </label>
        <p className="text-xs text-[var(--text-faint)]">
          You&apos;ll get an invite code to share. Anyone with it can join.
        </p>
      </Form>
    )
  }

  if (mode === 'join') {
    return (
      <Form
        title="Join a circle"
        submitLabel="Join"
        busy={busy}
        error={error}
        onCancel={() => setMode('choose')}
        onSubmit={() =>
          go(async (key) => {
            const { circle } = await joinCircle(connected.address, code, key)
            router.push(`/c/${circle.id}`)
          })
        }
      >
        <label className="flex flex-col gap-1.5">
          <span className="label">Invite code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="AB3XQ7"
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="input min-h-[3.5rem] text-center font-mono text-2xl font-semibold tracking-[0.28em]"
          />
        </label>
        <p className="text-xs text-[var(--text-faint)]">
          The four-to-eight-character code the host shared. Case does not matter.
        </p>
      </Form>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-[var(--radius-sm)] bg-[var(--no-wash)] px-3 py-2 text-sm text-[var(--no-strong)]">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Door
          title="Start a circle"
          body="You host. You get the invite code."
          accent
          onClick={() => setMode('create')}
        />
        <Door
          title="Join with a code"
          body="Someone already started one."
          onClick={() => setMode('join')}
        />
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          go(async () => {
            const { circles: mine } = await listCircles(connected.address)
            setCircles(mine)
          })
        }
        className="min-h-[2.75rem] text-sm text-[var(--text-muted)] underline underline-offset-2 disabled:opacity-60"
      >
        {busy ? 'Checking…' : 'I already have a code'}
      </button>
    </div>
  )
}

function Door({
  title,
  body,
  accent = false,
  onClick,
}: {
  title: string
  body: string
  accent?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-[7.25rem] flex-col items-start justify-between gap-3 rounded-[var(--radius)] border bg-[var(--surface-raised)] p-4 text-left shadow-[var(--shadow-card)] transition-all hover:border-[var(--border-strong)] active:scale-[0.99] ${
        accent ? 'border-[color-mix(in_oklch,var(--accent)_32%,transparent)]' : 'border-[var(--border)]'
      }`}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-base font-bold tracking-tight">{title}</span>
        <ArrowRight
          size={18}
          weight="bold"
          className={`transition-transform group-hover:translate-x-0.5 ${
            accent ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'
          }`}
        />
      </span>
      <span className="text-sm text-[var(--text-muted)]">{body}</span>
    </button>
  )
}

function Form({
  title,
  submitLabel,
  busy,
  error,
  children,
  onSubmit,
  onCancel,
}: {
  title: string
  submitLabel: string
  busy: boolean
  error: string | null
  children: React.ReactNode
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="pulse-card flex flex-col gap-4 p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-[2.75rem] rounded-[var(--radius)] px-2 text-sm text-[var(--text-muted)] underline underline-offset-2 disabled:opacity-60"
        >
          Back
        </button>
      </div>
      {children}
      {error && (
        <p role="alert" className="rounded-[var(--radius-sm)] bg-[var(--no-wash)] px-3 py-2 text-sm text-[var(--no-strong)]">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="btn btn-primary w-full"
      >
        {busy ? 'Working…' : submitLabel}
        <ArrowRight size={16} weight="bold" />
      </button>
    </form>
  )
}