import { db, PG_UNIQUE_VIOLATION, isPgError, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'

/**
 * Users. Identity is a Solana wallet and nothing else.
 *
 * There is no email column, password column, or reset-token column, and the
 * omission is deliberate (PRD §6). An empty schema does not stop a feature
 * being added under deadline pressure; a populated one does.
 *
 * `display_name` is nullable and user-editable. It is never a login credential
 * and never a unique key — two people are allowed to be called "Ada".
 */

export interface UserRow extends QueryResultRow {
  id: string
  wallet: string
  display_name: string | null
  created_at: Date
}

export interface User {
  id: string
  wallet: string
  displayName: string | null
  createdAt: Date
}

function toUser(row: UserRow): User {
  return { id: row.id, wallet: row.wallet, displayName: row.display_name, createdAt: row.created_at }
}

/**
 * Find a user by wallet address, or create one.
 *
 * Called on every wallet connection, so it has to be safe to call concurrently
 * from two devices with the same wallet. The upsert makes the create idempotent;
 * a bare INSERT-then-SELECT would race and throw 23505 on the loser.
 *
 * `display_name` is only overwritten when a non-null value is supplied, so a
 * wallet that connects without a name cannot blank out a name the user set.
 */
export async function upsertUser(
  wallet: string,
  displayName?: string | null,
  executor: Db = db,
): Promise<User> {
  const row = await executor.queryOne<UserRow>(
    `INSERT INTO users (wallet, display_name)
     VALUES ($1, $2)
     ON CONFLICT (wallet) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, users.display_name)
     RETURNING id, wallet, display_name, created_at`,
    [wallet, displayName ?? null],
  )
  // A conflict update always returns a row, so this is unreachable in practice.
  if (!row) throw new Error('user upsert returned no row')
  return toUser(row)
}

export async function findUserByWallet(wallet: string, executor: Db = db): Promise<User | null> {
  const row = await executor.queryOne<UserRow>(
    `SELECT id, wallet, display_name, created_at
       FROM users
      WHERE wallet = $1`,
    [wallet],
  )
  return row ? toUser(row) : null
}

export async function findUserById(id: string, executor: Db = db): Promise<User | null> {
  const row = await executor.queryOne<UserRow>(
    `SELECT id, wallet, display_name, created_at
       FROM users
      WHERE id = $1`,
    [id],
  )
  return row ? toUser(row) : null
}

/** Rename. Returns null if the user does not exist. */
export async function setDisplayName(
  id: string,
  displayName: string,
  executor: Db = db,
): Promise<User | null> {
  const row = await executor.queryOne<UserRow>(
    `UPDATE users
        SET display_name = $2
      WHERE id = $1
      RETURNING id, wallet, display_name, created_at`,
    [id, displayName],
  )
  return row ? toUser(row) : null
}

/**
 * Resolve a batch of wallets to users, keyed by wallet address.
 *
 * Used to decorate the trade tape with names. Deliberately returns only the
 * wallets asked for: this is called with wallet addresses that came off the
 * chain, and handing back the full user table would leak people who are not in
 * the session.
 */
export async function findUsersByWallets(
  wallets: readonly string[],
  executor: Db = db,
): Promise<Map<string, User>> {
  const unique = [...new Set(wallets)]
  if (unique.length === 0) return new Map()

  const rows = await executor.query<UserRow>(
    `SELECT id, wallet, display_name, created_at
       FROM users
      WHERE wallet = ANY($1::text[])`,
    [unique],
  )
  return new Map(rows.map((row) => [row.wallet, toUser(row)]))
}

export async function countUsers(executor: Db = db): Promise<number> {
  const row = await executor.queryOne<{ count: string }>(`SELECT count(*)::text AS count FROM users`)
  return row ? Number(row.count) : 0
}

export { PG_UNIQUE_VIOLATION, isPgError }
