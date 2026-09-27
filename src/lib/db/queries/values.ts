import type { QueryResultRow } from 'pg'

/**
 * Reading values that came back from Postgres.
 *
 * ⚠ `pg` returns NUMERIC as a STRING, not a number. That is deliberate on the
 * driver's part — NUMERIC can exceed what a float64 represents exactly — but it
 * means a careless `row.yes_price` is a string, and `row.yes_price * 100` is
 * `NaN` rather than an error. A price rendering as "NaN%" on a live market is
 * exactly the sort of thing that survives to a demo because nothing throws.
 *
 * Every NUMERIC read in ./queries goes through `toNum`. Prices are displayed and
 * compared, never used for settlement, so a float64 round-trip is safe here; the
 * authoritative amounts remain the ones Panta returned.
 */

export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** As `toNum`, but a missing or unparseable value becomes 0 rather than null. */
export function toNumOrZero(value: string | number | null | undefined): number {
  return toNum(value) ?? 0
}

export function toText(value: string | null | undefined): string | null {
  return value === undefined ? null : value
}

/** Narrow a driver row to the declared shape. Purely a type assertion. */
export function asRow<T extends QueryResultRow>(row: unknown): T {
  return row as T
}
