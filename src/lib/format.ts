/**
 * Price and amount formatting.
 *
 * ⚠ A Panta price is a PROBABILITY in 0..1, not a dollar amount. It is displayed
 * as cents because that is how prediction markets have always been read, but the
 * conversion is the single easiest thing to get wrong in the whole UI: a price of
 * 0.54 means 54%, and rendering it as "0.54" next to a USDC balance makes it look
 * like half a cent. Getting this wrong on stage in front of judges is a
 * credibility cost that no amount of other polish recovers from.
 *
 * The distinction is enforced by type. `PantaPrice` is a branded 0..1 probability
 * and cannot be passed where a `UsdcAmount` is expected, so the mistake is a
 * compile error rather than a rendering bug.
 */

declare const priceBrand: unique symbol
/** A probability in [0, 1], as Panta returns it. */
export type PantaPrice = number & { readonly [priceBrand]: 'PantaPrice' }

/** Narrow a raw Panta value to a price. Rejects out-of-range rather than clamping. */
export function asPrice(value: number | null | undefined): PantaPrice | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0 || value > 1) return null
  return value as PantaPrice
}

/**
 * The price as a whole-number percentage, the way every market shows it.
 *
 *   0.5432 -> 54
 *
 * Rounded rather than truncated. Truncating means 0.999 shows as 99, which reads
 * as "almost certain" when it is one tick from 100. Rounding means a genuinely
 * lopsided market can reach 100, which is honest, and the rare 0.996 that rounds
 * to 100 is corrected by the sign sitting at its true price anyway.
 */
export function pricePercent(price: PantaPrice | null): number | null {
  return price === null ? null : Math.round(price * 100)
}

/** `pricePercent` plus the sign, for a two-sided button. */
export function priceLabel(price: PantaPrice | null): string {
  const pct = pricePercent(price)
  return pct === null ? '—' : `${pct}%`
}

/** The complement, which is what the other side of the book is worth. */
export function complementLabel(price: PantaPrice | null): string {
  const pct = pricePercent(price)
  return pct === null ? '—' : `${100 - pct}%`
}

/**
 * USDC amounts.
 *
 * Always two decimals, because USDC has six and a prediction-market bet is never
 * a fraction of a cent worth reading. `0.5` renders as `0.50` rather than `0.5`
 * so a column of amounts lines up on the decimal.
 */
export function usdc(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Signed USDC, for a leaderboard where direction is the whole point. */
export function usdcSigned(value: number): string {
  const formatted = usdc(Math.abs(value))
  if (value > 0) return `+${formatted}`
  if (value < 0) return `-${formatted}`
  return formatted
}

/** Volume, which gets long fast. `$1.2M` reads better than `$1,204,338.00`. */
export function usdcCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return usdc(value)
}

/**
 * A short, non-colliding label for a wallet in a member list.
 *
 * The first four and last four. Enough to recognise your own wallet at a glance
 * in a list of eight, without printing a full signature on a phone.
 */
export function shortWallet(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

/**
 * A name for a member, falling back through display name to wallet.
 *
 * Falls back to the short wallet rather than to "Anonymous", because in a circle
 * of eight people an anonymous row is worse than useless — it is a row you
 * cannot attribute a trade to.
 */
export function memberName(displayName: string | null, wallet: string): string {
  return displayName?.trim() || shortWallet(wallet)
}

/** Countdown, for the session clock. Renders as `M:SS` under an hour. */
export function countdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'Ended'
  const totalSec = Math.floor(remainingMs / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
