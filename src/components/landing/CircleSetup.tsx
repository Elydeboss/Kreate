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
      <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm text-[var(--text-muted)]">
        Connect a wallet to start or join a circle. There is no sign-up — your wallet is your
        account.
      </p>
    )
  }

  // Already in a circle: the only useful thing to offer is the room.
  if (circles && circles.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text-muted)]">You&apos;re in:</p>
        <ul className="flex flex-col gap-2">
          {circles.map((circle) => (
            <li key={circle.id}>
              <button
                type="button"
                onClick={() => router.push(`/c/${circle.id}`)}
                className="flex min-h-[3.25rem] w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-4 text-left"
              >
                <span className="font-medium">{circle.name}</span>
                <span className="font-mono text-sm text-[var(--text-faint)]">{circle.code}</span>
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
          <span className="text-sm font-medium">What is it called?</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sunday match"
            maxLength={60}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="min-h-[2.75rem] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3"
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
          <span className="text-sm font-medium">Invite code</span>
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
            className="min-h-[3.25rem] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-center font-mono text-xl tracking-[0.2em]"
          />
        </label>
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
          body="You host. You get an invite code."
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

function Door({ title, body, onClick }: { title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[7rem] flex-col items-start justify-end gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-left"
    >
      <span className="text-base font-semibold">{title}</span>
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
      className="flex flex-col gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] p-4"
    >
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
      {error && (
        <p role="alert" className="rounded-[var(--radius-sm)] bg-[var(--no-wash)] px-3 py-2 text-sm text-[var(--no-strong)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-[2.75rem] rounded-[var(--radius)] border border-[var(--border)] px-4 text-sm"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={busy}
          className="min-h-[2.75rem] flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Working…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
