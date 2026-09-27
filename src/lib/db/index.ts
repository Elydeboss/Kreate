import 'server-only'

/**
 * Postgres access. The only module that opens connections.
 *
 * ⚠ TWO SEPARATE DOMAINS LIVE IN HERE (ARCHITECTURE.md §4.1):
 *
 *   Your domain    — users, circles, live_sessions, session_events. AUTHORITATIVE.
 *   Panta's domain — pulse_markets, market_trades. A CACHE of Panta's state.
 *
 *   If a pulse_markets row disagrees with GET /markets/{id}/, PANTA IS RIGHT.
 *   Refresh the cache. Never treat a local row as truth, and never present a
 *   local value to a user as live Panta data (Panta ToU §5).
 *
 * All SQL lives in ./queries. Nothing outside that directory writes SQL.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { DATABASE_URL } from '@/lib/server/env'

/**
 * The minimum surface a query module needs. Both the pool and a checked-out
 * transaction client satisfy it, so a query function can be called standalone or
 * composed inside a transaction without taking a second code path.
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>
  queryOne<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>
}

let pool: Pool | null = null

/**
 * Lazy singleton. Created on first use so that importing this module does not
 * open a connection during `next build`.
 *
 * Serverless note: each warm lambda holds its own pool. Keep `max` small (1-2) or
 * you will exhaust Postgres connection limits under concurrency, which presents
 * as a mysterious "too many clients" from the provider.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    })

    pool.on('error', (err) => {
      // An idle client erroring must not crash the lambda. The pool will discard
      // it; we log so the provider's connection ceiling is visible if it recurs.
      console.error('[db] idle client error', err.message)
    })
  }
  return pool
}

/** Run a parameterised query. Never interpolate values into the SQL string. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params)
  return result.rows
}

/** Run a query expected to return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Required for the write paths that must not half-apply: recording a
 * `pulse_markets` row and its `panta_creates` row together, and claiming an
 * idempotency key before performing a side effect.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error('[db] rollback failed', rollbackErr)
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Postgres unique-violation code. The schema uses constraints to express
 * several product rules, so this is an expected control-flow signal, not an
 * error — see the circle-join and dedupe paths in lib/db/queries.
 */
export const PG_UNIQUE_VIOLATION = '23505'
export const PG_FOREIGN_KEY_VIOLATION = '23503'
export const PG_CHECK_VIOLATION = '23514'

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code
}

/** A `Db` bound to the pool, for the common case of no explicit transaction. */
export const db: Db = { query, queryOne }

/** A `Db` bound to a transaction client. */
export function tx(client: PoolClient): Db {
  return {
    query: async <T extends QueryResultRow>(text: string, params: unknown[] = []) =>
      (await client.query<T>(text, params)).rows,
    queryOne: async <T extends QueryResultRow>(text: string, params: unknown[] = []) => {
      const result = await client.query<T>(text, params)
      return result.rows[0] ?? null
    },
  }
}
