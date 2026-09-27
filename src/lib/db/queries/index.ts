/**
 * The query layer. All SQL in Pulse lives under this directory.
 *
 * AGENTS.md rule 3: no SQL outside ./queries. A route handler asks these
 * functions questions; it does not know the schema. That is what keeps a
 * migration from requiring edits across every route, and it keeps connection
 * handling and transaction boundaries in one place.
 *
 * Import from the specific module you need rather than this barrel when you only
 * need one thing — the barrel re-exports everything, so a deep import stays a
 * deep import. The barrel exists for the few call sites that genuinely want
 * several.
 *
 * Modules:
 *   users       — wallet identity. No email, no password, no reset token.
 *   circles     — invite code and member list. The whole social layer.
 *   sessions    — live sessions, and the `ends_at` every market inherits.
 *   events      — session_events, INSERT ONLY. The ledger everything derives from.
 *   markets     — pulse_markets. A CACHE of Panta's state, plus our metadata.
 *   trades      — the real on-chain tape from Panta. Never synthesised.
 *   pantaFlows  — in-flight create/order ids, for reconciling a crashed run.
 *   scoreboard  — reads of v_scoreboard. Not yet validated; see that module.
 *   values      — reading NUMERIC columns. pg returns them as strings.
 */

export * as users from './users'
export * as circles from './circles'
export * as sessions from './sessions'
export * as events from './events'
export * as markets from './markets'
export * as trades from './trades'
export * as pantaFlows from './pantaFlows'
export * as scoreboard from './scoreboard'
export * from './values'
