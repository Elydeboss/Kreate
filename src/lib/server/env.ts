import 'server-only'

/**
 * The single place environment variables are read and validated.
 *
 * Nothing else in the codebase calls process.env directly. If a component or a
 * route needs a secret, it imports from here — which keeps every secret behind
 * the `server-only` guard and out of the client bundle.
 *
 * See AGENTS.md rule 1: no secret is ever NEXT_PUBLIC_.
 */

class MissingEnvError extends Error {
  constructor(name: string) {
    super(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    )
    this.name = 'MissingEnvError'
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') throw new MissingEnvError(name)
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') return fallback
  return value.trim()
}

/**
 * Panta API key. `pk_test_` and `pk_live_` both hit the same public API — the
 * prefix is a plan label, not a network. There is no Panta testnet, so
 * everything here is real mainnet USDC.
 */
export const PANTA_API_KEY = required('PANTA_API_KEY')

/**
 * Panta base URL. Hardcoded rather than env-configurable on purpose: Pulse only
 * ever talks to one host, and a stray env var pointing at a lookalike domain is
 * a credential-exfiltration bug. Trailing slashes are required on every route.
 */
export const PANTA_BASE_URL = 'https://live-api.panta.market/api/v1'

export const DATABASE_URL = required('DATABASE_URL')

/**
 * Solana RPC. The QuickNode token sits in the URL path, so this string IS the
 * credential — never log it in full. See `redactRpcUrl` below.
 */
export const SOLANA_RPC_URL = required('SOLANA_RPC_URL')

/**
 * Session nonce mixed into `question` so repeated demo runs mint distinct
 * markets instead of colliding on DUPLICATE_MARKET. Bump it deliberately; each
 * bump costs a real market-creation fee. See ARCHITECTURE.md §4.3.
 */
export const SESSION_NONCE = optional('PULSE_SESSION_NONCE', 'local')

export const env = {
  PANTA_API_KEY,
  PANTA_BASE_URL,
  DATABASE_URL,
  SOLANA_RPC_URL,
  SESSION_NONCE,
} as const

/**
 * Strips the token out of an RPC URL so it is safe to put in a log line.
 *
 * The QuickNode token is the last path segment, e.g.
 * `https://x.solana-mainnet.quiknode.pro/SECRET-TOKEN/`
 * becomes `https://x.solana-mainnet.quiknode.pro/SE…/`.
 */
export function redactRpcUrl(url: string = SOLANA_RPC_URL): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) return parsed.origin
    const last = segments[segments.length - 1]!
    segments[segments.length - 1] = last.length > 4 ? `${last.slice(0, 2)}***` : '***'
    return `${parsed.origin}/${segments.join('/')}/`
  } catch {
    return '[unparseable rpc url]'
  }
}
