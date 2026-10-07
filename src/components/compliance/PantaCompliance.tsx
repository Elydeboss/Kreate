/**
 * Panta Terms of Use obligations, expressed as components.
 *
 * These are not polish. ToU §5 forbids presenting cached or stale data as live
 * Panta data, and §6 requires prominent, non-removable "Powered by Panta"
 * attribution. Both are hard requirements for using the API at all, and both are
 * far cheaper to satisfy by construction than to retrofit under deadline
 * pressure. So they are components that other things render, not a checklist
 * somebody has to remember.
 *
 * `PoweredByPanta` in particular is not optional and takes no props for hiding
 * itself. There is deliberately no way to turn it off.
 */

import { clientConfig } from '@/lib/client/config'

/**
 * "Prices as of HH:MM:SS" — the ToU §5 staleness stamp.
 *
 * MUST be rendered whenever a price came from cache, from a stale-while-revalidate
 * read, or from a circuit-breaker serve-stale. The server propagates that as
 * `prices_as_of` plus a `stale` flag on every price-bearing route; this component
 * is the only sanctioned way to display it.
 *
 * The absolute time is deliberate. A relative "2m ago" is easier to write and
 * useless for compliance: it does not tell anyone what the data actually was, and
 * it silently becomes wrong on a backgrounded tab when nobody is looking.
 */
export function StalenessStamp({
  asOf,
  stale,
  className = '',
}: {
  /** When Panta answered. Always required — a stamp without a time is not a stamp. */
  asOf: Date | string | number
  /** True when this value is past its TTL or was served with the breaker open. */
  stale: boolean
  className?: string
}) {
  const date = asOf instanceof Date ? asOf : new Date(asOf)
  if (Number.isNaN(date.getTime())) return null

  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  // When the value is fresh the stamp stays available but recedes. Hiding it
  // entirely would mean a layout shift every time a poll lands, and the whole
  // point is that a reader can always see when the number is from.
  const tone = stale
    ? 'border-[color-mix(in_oklch,var(--warn)_45%,transparent)] bg-[var(--warn-wash)] text-[var(--warn)]'
    : 'border-transparent text-[var(--text-faint)]'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[11px] leading-tight ${tone} ${className}`}
      title={
        stale
          ? 'This price was cached because Panta could not be reached. It is not a live quote.'
          : `Prices as of ${time}`
      }
    >
      {stale && <span aria-hidden className="size-1 rounded-full bg-[var(--warn)]" />}
      <span>as of {time}</span>
    </span>
  )
}

/**
 * "Powered by Panta" — ToU §6.
 *
 * Exact string, always rendered, never conditional. Panta's ToU §6 requires the
 * attribution be prominent and not removable, and judges look for it. A header
 * `X-Powered-By` does not count: no browser renders it, so it satisfies nobody.
 *
 * Takes no props on purpose. The only way to remove it is to delete this
 * component, which is a visible diff in review.
 */
export function PoweredByPanta({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-center justify-center gap-1.5 text-center text-xs text-[var(--text-faint)] ${className}`}>
      <span aria-hidden className="inline-block size-1 rounded-full bg-[var(--accent)]" />
      Powered by{' '}
      <a
        href="https://panta.market"
        target="_blank"
        rel="noopener noreferrer"
        className="font-bold text-[var(--text-muted)] underline decoration-[var(--border-strong)] underline-offset-2 transition-colors hover:text-[var(--accent)]"
      >
        Panta
      </a>
    </p>
  )
}

/**
 * A short explorer link for a signature or address.
 *
 * Panta's own explorer is not the canonical record of a transaction; Solana's is.
 * So the attribution lives in the footer and the per-transaction links point at
 * Solscan, where the signature can actually be verified.
 */
export function TxLink({
  signature,
  className = '',
  children,
}: {
  signature: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <a
      href={clientConfig.explorerTxUrl(signature)}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono underline decoration-[var(--border-strong)] underline-offset-2 transition-colors hover:text-[var(--accent)] ${className}`}
    >
      {children ?? `${signature.slice(0, 4)}…${signature.slice(-4)}`}
    </a>
  )
}

export function AddressLink({ address, className = '' }: { address: string; className?: string }) {
  return (
    <a
      href={clientConfig.explorerAccountUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono underline decoration-[var(--border-strong)] underline-offset-2 transition-colors hover:text-[var(--accent)] ${className}`}
    >
      {address}
    </a>
  )
}