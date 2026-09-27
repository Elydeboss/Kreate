/**
 * TRANSACTION SHAPE A — the pre-assembled path.
 *
 * Used by: market creation (`/markets/create/build/`).
 *
 * Panta returns a COMPLETE, UNSIGNED, base64-encoded `VersionedTransaction`.
 * You deserialize it, sign it, and broadcast it. You do NOT compile anything and
 * you do NOT touch the instruction list.
 *
 * This is deliberately a SEPARATE FILE from instructionTx.ts. See the note there
 * and AGENTS.md rule 4: the two build responses are different shapes and must
 * never be handled by one helper.
 *
 * This module runs in the BROWSER. It never touches the Panta key.
 */

import { VersionedTransaction, type Connection } from '@solana/web3.js'
import type { CreateBuildResponse } from '@/lib/panta/types'
import type { TxSigner } from './instructionTx'

/**
 * Deserialize Panta's base64 blob into a VersionedTransaction.
 *
 * `VersionedTransaction.deserialize` throws on a malformed payload, so a corrupt
 * response surfaces here rather than as a confusing broadcast failure. It also
 * verifies the internal consistency of the message, which is a free sanity check
 * before we ask the user to sign.
 */
export function deserializeCreateTransaction(build: CreateBuildResponse): VersionedTransaction {
  if (!build.transaction) {
    throw new Error('Panta create/build returned no transaction')
  }
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(build.transaction, 'base64')
  } catch {
    throw new Error('Panta create/build returned a transaction that is not valid base64')
  }
  if (bytes.byteLength === 0) {
    throw new Error('Panta create/build returned an empty transaction')
  }
  return VersionedTransaction.deserialize(bytes)
}

/**
 * Deserialize, sign, and broadcast a market-creation transaction.
 * Returns the signature to POST back to `/markets/register/`.
 *
 * ⚠ THE RETURN VALUE OF `signTransaction` IS THE ONE THAT GETS SENT. It returns
 * a new transaction rather than signing in place, because `TxSigner` wraps
 * Wallet Standard's bytes-in/bytes-out interface. `await signer.signTransaction(tx)`
 * followed by `tx.serialize()` broadcasts an unsigned transaction and fails on
 * chain with a signature error that points nowhere near the bug. Both tx paths
 * had this; see the note in instructionTx.ts.
 */
export async function signAndSendCreateTx(params: {
  connection: Connection
  build: CreateBuildResponse
  signer: TxSigner
  skipPreflight?: boolean
}): Promise<string> {
  const { connection, build, signer, skipPreflight = false } = params

  const tx = deserializeCreateTransaction(build)
  // Catch the common failure before the wallet popup rather than after it. A
  // stale createId still carries a perfectly valid fee payer, so this is the only
  // place the mismatch is visible, and it is visible to a user who can act.
  assertSignableBy(tx, signer.publicKey.toBase58())

  const signed = await signer.signTransaction(tx)

  return connection.sendRawTransaction(signed.serialize(), {
    maxRetries: 3,
    skipPreflight,
    preflightCommitment: 'confirmed',
  })
}

/**
 * Sanity-check a creation transaction before showing it to the user.
 *
 * Catches the two failure modes that kill the live demo, while there is still
 * time to recover:
 *   - no fee payer set, so signing would fail in the wallet popup
 *   - the transaction Panta built does not belong to the user about to sign it
 */
export function assertSignableBy(tx: VersionedTransaction, signerPublicKey: string): void {
  const feePayer = tx.message.staticAccountKeys[0]
  if (!feePayer) {
    throw new Error('Creation transaction has no fee payer')
  }
  if (feePayer.toBase58() !== signerPublicKey) {
    throw new Error(
      `Creation transaction fee payer does not match the connected wallet. ` +
        `Expected ${signerPublicKey}, got ${feePayer.toBase58()}. ` +
        `The createId is probably stale — start a new quote.`,
    )
  }
}
