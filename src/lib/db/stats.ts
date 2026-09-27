import 'server-only'

/**
 * Cheap liveness probe for the database.
 *
 * Deliberately does NOT throw. A health check that throws takes down the page
 * that reports it. Callers branch on `ok`.
 */
export function dbStatsPlaceholder(): { ok: boolean; detail: string } {
  const url = process.env.DATABASE_URL
  if (!url) return { ok: false, detail: 'DATABASE_URL not set' }
  try {
    const parsed = new URL(url)
    return { ok: true, detail: `${parsed.hostname}:${parsed.port || '5432'}` }
  } catch {
    return { ok: false, detail: 'DATABASE_URL is unparseable' }
  }
}
