/**
 * Client-safe configuration. The ONLY module a browser component may read config
 * from.
 *
 * ⚠ This file must never import `@/lib/server/env`. That module is
 * `server-only` and holds the Panta key, the Postgres URL, and the private
 * Solana RPC. Keeping the two files physically separate is what makes the
 * boundary checkable — a reviewer reads the import graph, not a convention.
 *
 * AGENTS.md rule 1: the Panta key is never NEXT_PUBLIC_. Panta ToU §3 says the
 * same. Nothing in this file may ever hold a Panta key, a Postgres URL, or a
 * QuickNode token.
 */

/**
 * The RPC the browser broadcasts through.
 *
 * WHY THE CLIENT NEEDS ONE AT ALL. Pulse signs in the browser and broadcasts
 * from the browser, so a signed transaction never touches our server. That is
 * deliberate: a server that never sees a signed transaction has nothing to leak
 * and nothing to be subpoenaed for. The cost is that the browser needs *some*
 * RPC to relay through.
 *
 * WHY A MALICIOUS RPC IS NOT A FUNDS RISK. A node cannot forge a signature or
 * alter an amount — it can only refuse to relay, or lie about confirmation. So
 * the worst a hostile endpoint can do is make a transaction fail to land, not
 * steal from it. That is why a public endpoint is an acceptable default here
 * even though it is a poor one for reads.
 *
 * THE TRADEOFF, STATED PLAINLY. Setting NEXT_PUBLIC_SOLANA_RPC_URL inlines the
 * URL — and therefore a QuickNode token — into the JS bundle, where anyone can
 * read it. That is acceptable only if the token is domain-restricted in the
 * QuickNode dashboard, which limits the damage to requests from our own origin.
 *
 *   Leave it unset  -> public mainnet-beta endpoint. Free, no secret, but rate
 *                      limited and occasionally unreliable. Fine for a handful
 *                      of demo users, a poor choice for a live watch party.
 *   Set it         -> your own endpoint. Reliable, and the token is public.
 *                      Restrict it by domain or do not set it.
 *
 * The server keeps a separate, private SOLANA_RPC_URL for every *read*. That is
 * where rate limits actually bite and where the token must stay secret.
 */
export const PUBLIC_SOLANA_RPC_FALLBACK = 'https://api.mainnet-beta.solana.com'

function readPublicRpc(): string {
  const value = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return PUBLIC_SOLANA_RPC_FALLBACK
}

export const clientConfig = {
  rpcUrl: readPublicRpc(),
  /** Cluster id the wallet must support. Panta is mainnet-only, with no testnet. */
  cluster: 'solana:mainnet' as const,
  /** Explorer for signatures. Null entries are shown as a bare signature. */
  explorerTxUrl: (signature: string) => `https://solscan.io/tx/${signature}`,
  explorerAccountUrl: (address: string) => `https://solscan.io/account/${address}`,
} as const
