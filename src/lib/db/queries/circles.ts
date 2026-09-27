import { db, isPgError, PG_UNIQUE_VIOLATION, transaction, tx, type Db } from '@/lib/db'
import type { QueryResultRow } from 'pg'
import { upsertUser } from './users'

/**
 * Circles: an invite code and a member list. That is the entire social layer.
 *
 * Roles, moderation, email invites, and a feed were all cut (PRD §6). What
 * remains is small enough to hold in one head, which is the point — the social
 * layer exists to make a watch party feel like a watch party, and nothing more.
 */

export interface CircleRow extends QueryResultRow {
  id: string
  code: string
  name: string
  created_by: string
  created_at: Date
}

export interface Circle {
  id: string
  code: string
  name: string
  createdBy: string
  createdAt: Date
}

export interface CircleMember {
  userId: string
  wallet: string
  displayName: string | null
  joinedAt: Date
}

/**
 * Code alphabet.
 *
 * Excludes 0/O and 1/I/L. A code gets read aloud across a watch party and typed
 * one-handed on a phone, and `O` versus `0` is the single most common way a
 * correct code gets entered wrong. Six characters from a 32-symbol alphabet is
 * ~1.1 billion combinations, so collisions are cheap to retry.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

/**
 * Generate an invite code.
 *
 * Uses rejection sampling over the alphabet rather than `charAt(randomIndex)`.
 * The modulo bias from the last index is small but free to avoid, and this
 * function is called on a user-visible path where "random" should mean random.
 */
function generateCode(): string {
  let out = ''
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (out.length === CODE_LENGTH) break
      // Discard values past the largest whole multiple, which would otherwise be
      // over-represented by the modulo.
      if (byte < max) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
  }
  return out
}

function toCircle(row: CircleRow): Circle {
  return { id: row.id, code: row.code, name: row.name, createdBy: row.created_by, createdAt: row.created_at }
}

/**
 * Create a circle and add its creator as the first member.
 *
 * The membership row and the circle row go in one transaction. A circle with
 * nobody in it is unjoinable — the creator would get a code that silently does
 * nothing — so the two writes must not be separable.
 *
 * Collisions on the code are retried rather than surfaced. A 23505 here is
 * almost always a code collision, not a bad insert, and the caller should never
 * have to distinguish them.
 */
export async function createCircle(
  name: string,
  creatorId: string,
  executor: Db = db,
): Promise<Circle> {
  const attempts = 5
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const code = generateCode()
    try {
      // The membership insert is folded into the caller's transaction when one is
      // supplied, so a crash cannot leave a circle without its creator.
      const row = await executor.queryOne<CircleRow>(
        `INSERT INTO circles (code, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, code, name, created_by, created_at`,
        [code, name.trim(), creatorId],
      )
      if (!row) throw new Error('circle insert returned no row')

      await executor.query(
        `INSERT INTO circle_members (circle_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [row.id, creatorId],
      )
      return toCircle(row)
    } catch (err) {
      if (!isPgError(err, PG_UNIQUE_VIOLATION)) throw err
      lastError = err
    }
  }

  // Five consecutive collisions on a 32^6 space means something is wrong beyond
  // chance — most likely a test fixture inserting a fixed code.
  throw new Error(`could not allocate a unique invite code: ${String(lastError)}`)
}

export async function findCircleByCode(
  code: string,
  executor: Db = db,
): Promise<Circle | null> {
  // Codes are matched case-insensitively and whitespace-tolerantly, because a
  // shared code is very often pasted with a trailing space or a lowercase letter.
  const row = await executor.queryOne<CircleRow>(
    `SELECT id, code, name, created_by, created_at
       FROM circles
      WHERE upper(btrim(code)) = upper(btrim($1))`,
    [code],
  )
  return row ? toCircle(row) : null
}

export async function findCircleById(id: string, executor: Db = db): Promise<Circle | null> {
  const row = await executor.queryOne<CircleRow>(
    `SELECT id, code, name, created_by, created_at
       FROM circles
      WHERE id = $1`,
    [id],
  )
  return row ? toCircle(row) : null
}

export async function listCirclesForUser(userId: string, executor: Db = db): Promise<Circle[]> {
  const rows = await executor.query<CircleRow>(
    `SELECT c.id, c.code, c.name, c.created_by, c.created_at
       FROM circles c
       JOIN circle_members m ON m.circle_id = c.id
      WHERE m.user_id = $1
      ORDER BY c.created_at DESC`,
    [userId],
  )
  return rows.map(toCircle)
}

export interface JoinResult {
  circle: Circle
  /** False when the wallet was already a member. Drives "you're already in". */
  joined: boolean
}

/**
 * Join a circle by code.
 *
 * Returns null for an unknown code, so a caller can tell "no such circle" from
 * "circle exists but you are already in it" — two very different messages, and
 * the second is the common one when a link is shared twice.
 */
export async function joinCircleByCode(code: string, userId: string, executor: Db = db): Promise<JoinResult | null> {
  const circle = await findCircleByCode(code, executor)
  if (!circle) return null

  const row = await executor.queryOne<{ inserted: boolean }>(
    `INSERT INTO circle_members (circle_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING true AS inserted`,
    [circle.id, userId],
  )
  return { circle, joined: row !== null }
}

export async function isMember(
  circleId: string,
  userId: string,
  executor: Db = db,
): Promise<boolean> {
  const row = await executor.queryOne<{ present: boolean }>(
    `SELECT true AS present
       FROM circle_members
      WHERE circle_id = $1 AND user_id = $2`,
    [circleId, userId],
  )
  return row !== null
}

/**
 * Require membership, or throw.
 *
 * The authorisation boundary for every circle-scoped read and write. Throwing
 * rather than returning null keeps the "did this pass?" check impossible to skip
 * at a call site: the alternative is a nullable return that a caller forgets to
 * check, which is a data leak rather than a bug.
 */
export async function requireMembership(
  circleId: string,
  userId: string,
  executor: Db = db,
): Promise<void> {
  if (!(await isMember(circleId, userId, executor))) {
    throw new Error('not a member of this circle')
  }
}

export async function listMembers(circleId: string, executor: Db = db): Promise<CircleMember[]> {
  const rows = await executor.query<
    QueryResultRow & { user_id: string; wallet: string; display_name: string | null; joined_at: Date }
  >(
    `SELECT u.id AS user_id, u.wallet, u.display_name, m.joined_at
       FROM circle_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.circle_id = $1
      ORDER BY m.joined_at ASC`,
    [circleId],
  )
  return rows.map((row) => ({
    userId: row.user_id,
    wallet: row.wallet,
    displayName: row.display_name,
    joinedAt: row.joined_at,
  }))
}

export async function memberCount(circleId: string, executor: Db = db): Promise<number> {
  const row = await executor.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM circle_members WHERE circle_id = $1`,
    [circleId],
  )
  return row ? Number(row.count) : 0
}

/**
 * Create a circle for a wallet, creating the user first if needed.
 *
 * Convenience for the create-circle route, which only ever has a wallet address
 * and may not have come through the user upsert path yet.
 *
 * Runs in a transaction because the user row, the circle row, and the creator's
 * membership row are only meaningful together: a circle whose creator is not a
 * member hands out a code that appears to do nothing.
 */
export async function createCircleForWallet(
  name: string,
  wallet: string,
  displayName?: string | null,
): Promise<Circle> {
  return transaction(async (client) => {
    const executor = tx(client)
    const user = await upsertUser(wallet, displayName, executor)
    return createCircle(name, user.id, executor)
  })
}
