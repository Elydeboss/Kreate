import 'server-only'

/**
 * Who is asking.
 *
 * ⚠ THE HONEST VERSION OF THIS: Pulse identifies users by a wallet address sent
 * in a request header, and that is trivially forgeable. Anyone can claim to be
 * any address. This is a known, accepted gap, not an oversight, and the reason
 * it is acceptable is narrow and specific:
 *
 *   NOTHING THAT ATTRIBUTES MONEY IS DERIVED FROM THIS HEADER.
 *
 * The scoreboard — the only place a real number hangs on a real person's
 * reputation — is built from `session_events` rows whose `actor_user_id` is
 * resolved from the `wallet` field of Panta's own trade tape, by
 * `syncMarketTape` in lib/db/queries/trades.ts. A caller cannot forge a trade,
 * cannot forge its amount, and cannot forge its wallet, because none of those
 * values originate with the caller. The market they "bet" on has to have been
 * paid for in real USDC by the real wallet, and Panta reports that transaction.
 * See ARCHITECTURE.md §4.6.
 *
 * What a forged header CAN do: create a circle, name a market, and set a
 * display name. All cosmetic. None of it can move money, fabricate a position,
 * or inflate a leaderboard.
 *
 * WHY NOT FIX IT NOW. The real fix is a SIWE-style challenge: the server issues a
 * nonce, the wallet signs it, and the server verifies the signature against the
 * claimed address. That is maybe half a day including the failure modes, and it
 * buys protection for a set of actions that are already cosmetic. On a 16-day
 * clock the better use of that half day is the create/buy/claim path that is
 * being judged. Record it, do not fake it.
 */

import { PublicKey } from '@solana/web3.js'
import { upsertUser, type User } from '@/lib/db/queries/users'

/** Header the browser sends its connected address in. */
export const WALLET_HEADER = 'x-pulse-wallet'

export class MissingWalletError extends Error {
  constructor() {
    super('Connect a wallet first.')
    this.name = 'MissingWalletError'
  }
}

export class InvalidWalletError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'InvalidWalletError'
  }
}

/**
 * Validate a claimed wallet address.
 *
 * Rejects anything base58 is not a valid 32-byte public key for. This is not
 * authentication — see the note above — it is input validation, so a malformed
 * header cannot reach the database as an invalid `users.wallet` and trip the
 * schema's CHECK constraint with a 500 instead of a 400.
 */
export function parseWallet(raw: string | null | undefined): string {
  if (!raw || raw.trim() === '') throw new MissingWalletError()
  const trimmed = raw.trim()

  try {
    const key = new PublicKey(trimmed)
    // Reject the all-zero and all-ones edge cases: they are valid base58 of the
    // right length but no real wallet has them, and they would sail through a
    // length check and produce a user nobody can ever trade as.
    if (key.equals(PublicKey.default)) throw new Error('default public key')
    if (key.toBytes().every((b) => b === 0xff)) throw new Error('all-ones public key')
  } catch {
    throw new InvalidWalletError('That does not look like a Solana wallet address.')
  }
  return trimmed
}

/**
 * Resolve the calling wallet to a user, creating the row on first sight.
 *
 * Upserts, so a first-time visitor who connects and immediately hits an API
 * route does not have to go through a separate registration step. There is no
 * registration step.
 */
export async function userFromRequest(request: Request, displayName?: string | null): Promise<User> {
  const wallet = parseWallet(request.headers.get(WALLET_HEADER))
  return upsertUser(wallet, displayName ?? null)
}

/** As above, but returns null instead of throwing. For optional-auth routes. */
export async function optionalUserFromRequest(
  request: Request,
): Promise<User | null> {
  const raw = request.headers.get(WALLET_HEADER)
  if (!raw || raw.trim() === '') return null
  try {
    const wallet = parseWallet(raw)
    return await upsertUser(wallet, null)
  } catch {
    return null
  }
}
