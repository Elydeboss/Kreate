import 'server-only'

/**
 * Assertions about database state, made at the moment something is about to be
 * written that depends on it.
 *
 * These live apart from the flow modules on purpose. `marketCreate.ts` and
 * `marketBuy.ts` are siblings — neither is a helper for the other — and a guard
 * that both need is a third thing, not something one of them should own. An
 * import of `marketCreate` from `marketBuy` would couple two flows that can fail
 * independently, and the next guard would go in whichever file was edited last.
 *
 * The rule they all follow: a write that would produce an unattributable record
 * is refused, not repaired. A `session_events` row with a null session, or a
 * trade whose market we cannot name, is worse than no row at all — it looks like
 * data, so it will be believed, and it cannot be explained or corrected later.
 */

export class InvariantError extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(message: string, code: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'InvariantError'
    this.code = code
    this.detail = detail
  }
}

/**
 * A market's session id, or a refusal.
 *
 * `pulse_markets.session_id` is nullable because a market can exist outside a
 * live room. But every event we append is scoped to a session — the room, the
 * tape, and the scoreboard are all session-scoped views — so a market with no
 * session cannot produce a meaningful event. Reaching here means a market was
 * created outside the flow that guarantees a session, which is a bug to find
 * rather than a state to work around.
 *
 * `what` names the thing that has no session, so the log says which one.
 */
export function requireSessionId(
  sessionId: string | null,
  what: string,
): string {
  if (!sessionId) {
    throw new InvariantError(`${what} has no session, so it cannot write a session event.`, 'NO_SESSION', { what })
  }
  return sessionId
}

/**
 * A transaction signature, or a refusal.
 *
 * Every receipt route in Pulse takes a signature from the client and hands it
 * straight to Panta. Panta's own validation is authoritative and thorough, and
 * this is not a replacement for it — it exists so a truncated string or a
 * `undefined` that became the literal string "undefined" is a 400 to us, rather
 * than an upstream 400 that reads like a Panta fault and burns a slot in the
 * `register` family rate limit.
 *
 * 64 bytes of base58 is 87 or 88 characters, depending on the leading byte. Both
 * are accepted; anything else is not a Solana signature and there is no reason
 * to forward it.
 */
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/

export function requireSignature(raw: unknown): string {
  if (typeof raw !== 'string' || !SIGNATURE_PATTERN.test(raw)) {
    throw new InvariantError('That is not a valid transaction signature.', 'BAD_SIGNATURE')
  }
  return raw
}
