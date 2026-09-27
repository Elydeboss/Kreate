/**
 * TRANSACTION SHAPE B — the compile path.
 *
 * Used by: primary buy (`/primaryorderbuild/`) and win claim (`/claim/build/`).
 * Both return raw `instructions[]` that you must assemble into a transaction
 * yourself. There is no pre-built blob.
 *
 * This is deliberately a SEPARATE FILE from createTx.ts. The two Panta `build`
 * endpoints return different shapes, and a shared helper is exactly how you end
 * up calling `VersionedTransaction.deserialize()` on a buy response at 2am before
 * a demo. The file split makes that mistake look wrong. See AGENTS.md rule 4.
 *
 * ⚠ THE TIGHTEST CONSTRAINT IN THE PRODUCT: the blockhash Panta returns is valid
 * for roughly 60 seconds. Quote -> build -> sign (wallet popup) -> broadcast must
 * complete inside that. On mobile that is genuinely tight. Mitigations are in
 * docs/ARCHITECTURE.md §3.5: quote when the buy sheet opens, build only on
 * confirm, and auto-requote once on QUOTE_STALE.
 *
 * This module runs in the BROWSER. It never touches the Panta key.
 */

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Transaction,
} from '@solana/web3.js'
import type { PantaInstruction } from '@/lib/panta/types'

/**
 * Minimal signer surface. Matches both Phantom and Solflare wallet adapters,
 * and is trivial to fake in a test.
 */
export interface TxSigner {
  publicKey: PublicKey
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}

/**
 * Convert one Panta instruction into a web3.js instruction.
 *
 * Panta returns `data` base64-encoded. It is NOT hex — decoding it as hex
 * produces a transaction that signs fine and then fails on chain with an
 * inscrutable error.
 */
export function toTransactionInstruction(ix: PantaInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  })
}

/**
 * Compile Panta's instructions into a signed VersionedTransaction.
 *
 * Always v0. Panta's instruction list may reference address lookup table
 * accounts, which only compile under a v0 message.
 */
export async function buildInstructionTransaction(
  instructions: PantaInstruction[],
  recentBlockhash: string,
  signer: TxSigner,
): Promise<VersionedTransaction> {
  if (instructions.length === 0) {
    throw new Error('Panta returned an empty instruction list')
  }

  const message = new TransactionMessage({
    recentBlockhash,
    payerKey: signer.publicKey,
    instructions: instructions.map(toTransactionInstruction),
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  await signer.signTransaction(tx)
  return tx
}

/**
 * Compile, sign and broadcast in one call. Returns the signature.
 *
 * Broadcasting happens HERE, client-side, so the signed transaction never
 * touches the Pulse server. See AGENTS.md rule 5.
 */
export async function signAndSendInstructionTx(params: {
  connection: Connection
  instructions: PantaInstruction[]
  recentBlockhash: string
  signer: TxSigner
  /** Preflight is expensive; keep it on for the demo, not in a retry loop. */
  skipPreflight?: boolean
}): Promise<string> {
  const { connection, instructions, recentBlockhash, signer, skipPreflight = false } = params

  const tx = await buildInstructionTransaction(instructions, recentBlockhash, signer)

  return connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
    skipPreflight,
    preflightCommitment: 'confirmed',
  })
}
