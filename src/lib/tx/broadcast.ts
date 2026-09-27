/**
 * Broadcast and confirmation helpers.
 *
 * All broadcasting happens in the BROWSER. Signed transactions never reach the
 * Pulse server — the client POSTs back only the resulting signature, for
 * `register` / `submit` / `trades`. See AGENTS.md rule 5.
 *
 * The job of this file is the part that is easy to skip and fatal to skip:
 * waiting for the transaction to actually land, using the `lastValidBlockHeight`
 * Panta handed us at build time.
 */

import {
  Connection,
  VersionedTransaction,
  type Commitment,
  type SendOptions,
  type TransactionConfirmationStatus,
} from '@solana/web3.js'
import type { TxSigner } from './instructionTx'

export const DEFAULT_COMMITMENT: Commitment = 'confirmed'

/**
 * Sign a transaction and broadcast it. Thin wrapper so both tx paths share one
 * set of send options and one place where preflight is configured.
 */
export async function signAndBroadcast(
  connection: Connection,
  tx: VersionedTransaction,
  signer: TxSigner,
  options: SendOptions = {},
): Promise<string> {
  await signer.signTransaction(tx)
  return connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
    skipPreflight: false,
    preflightCommitment: DEFAULT_COMMITMENT,
    ...options,
  })
}

export interface ConfirmParams {
  connection: Connection
  signature: string
  /**
   * The `lastValidBlockHeight` Panta returned with the build. Do not substitute
   * a fresh one — the transaction is only valid against the blockhash it was
   * built with.
   */
  lastValidBlockHeight: number
  /** Commit to before declaring failure. 'confirmed' is fine for a demo. */
  commitment?: Commitment
  /** Overall wall-clock cap. Roughly two Solana slots per attempt. */
  timeoutMs?: number
  onAttempt?: (attempt: number) => void
}

export class ConfirmationTimeoutError extends Error {
  readonly signature: string
  constructor(signature: string, timeoutMs: number) {
    super(
      `Transaction ${signature} was not confirmed within ${timeoutMs}ms. ` +
        `It may still land — check the signature before retrying, or you may ` +
        `end up with two positions.`,
    )
    this.name = 'ConfirmationTimeoutError'
    this.signature = signature
  }
}

/** Commitment levels, weakest first. RPCs report the level actually reached. */
const COMMITMENT_RANK: Record<string, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
}

function reached(actual: TransactionConfirmationStatus | undefined, wanted: Commitment): boolean {
  if (!actual) return false
  const rank = COMMITMENT_RANK[actual]
  if (rank === undefined) return false
  return rank >= (COMMITMENT_RANK[wanted] ?? 1)
}

/**
 * Wait for confirmation, bounded by `lastValidBlockHeight`.
 *
 * Polls `getSignatureStatuses` rather than using `confirmTransaction` with a
 * blockhash strategy. Two reasons:
 *   1. The status response gives an explicit `err` field. `confirmTransaction`
 *      signals a reverted transaction by resolving rather than rejecting, which
 *      is an easy way to report a failed trade as a success.
 *   2. The blockhash-strategy return type has changed shape across web3.js
 *      minor versions. Polling is explicit and stable.
 *
 * The block-height ceiling is checked every pass, so an expired transaction
 * fails in a couple of seconds instead of hanging to the wall-clock timeout.
 */
export async function confirmTransaction(params: ConfirmParams): Promise<void> {
  const {
    connection,
    signature,
    lastValidBlockHeight,
    commitment = DEFAULT_COMMITMENT,
    timeoutMs = 60_000,
    onAttempt,
  } = params

  const deadline = Date.now() + timeoutMs
  let attempt = 0

  for (;;) {
    attempt += 1
    onAttempt?.(attempt)

    if (Date.now() >= deadline) throw new ConfirmationTimeoutError(signature, timeoutMs)

    const [status] = (await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })).value

    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed on chain: ${JSON.stringify(status.err)}`)
      }
      if (reached(status.confirmationStatus, commitment)) return
    }

    // Past the blockhash ceiling the transaction can never be included.
    const blockHeight = await connection.getBlockHeight('finalized')
    if (blockHeight > lastValidBlockHeight) {
      throw new ConfirmationTimeoutError(signature, 0)
    }

    await new Promise((resolve) => setTimeout(resolve, 800))
  }
}

/**
 * Poll an order's status until it settles.
 *
 * Panta's `/primaryorderverify/` moves built -> submitted -> confirmed|failed.
 * The UI needs a terminal answer to show the user, and it needs it without
 * holding a request open.
 */
export async function pollOrderStatus(
  verify: (orderId: string) => Promise<{ status: string; error?: string }>,
  orderId: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<{ status: string; error?: string }> {
  const attempts = options.attempts ?? 10
  const intervalMs = options.intervalMs ?? 2000

  let last: { status: string; error?: string } = { status: 'submitted' }
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await verify(orderId)
    if (last.status === 'confirmed' || last.status === 'failed') return last
  }
  // Not terminal. The caller decides whether to keep waiting in the background;
  // the signature is already on chain, so nothing is lost by reporting "still
  // settling" rather than an error.
  return { status: last.status, error: undefined }
}
