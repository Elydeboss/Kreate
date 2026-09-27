'use client'

/**
 * Wallet connection via the Wallet Standard.
 *
 * WHY NOT @solana/wallet-adapter-react. It depends on the Solana *mobile* wallet
 * adapter, which drags React Native, Hermes and sharp into the dependency tree —
 * over a gigabyte of install for what is a mobile *web* app. The Wallet Standard
 * is the same interface without that baggage, and it maps directly onto the
 * `TxSigner` shape our transaction paths already expect.
 *
 * WHY ROLL OUR OWN BUTTON. The connection UI is one of the judged criteria, and
 * it is a sheet listing discovered wallets plus a connect button. That is less
 * work than bending a generic modal, and it is the only wallet surface Pulse
 * has. See PRD §6 — embedded wallets and multi-wallet fanciness were cut.
 *
 * WHY A LOCAL `PulseWallet` INTERFACE. The standard types `features` as an open
 * `IdentifierRecord<unknown>`, so the shipped generics cannot narrow to the
 * three features we use. Typing the runtime shape we actually depend on is both
 * clearer and more honest, and the guard below validates it at runtime rather
 * than trusting a cast.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Connection,
  PublicKey,
  Transaction as LegacyTransaction,
  VersionedTransaction,
  type Transaction,
} from '@solana/web3.js'
import { getWallets } from '@wallet-standard/app'
import type { TxSigner } from '@/lib/tx/instructionTx'

/** The subset of a Wallet Standard wallet that Pulse actually uses. */
interface PulseWallet {
  name: string
  version: string
  icon?: string
  chains: readonly string[]
  accounts: readonly { address: string; label?: string; icon?: string }[]
  features: {
    connect?: { connect(): Promise<void> }
    disconnect?: { disconnect(): Promise<void> }
    'solana:signTransaction'?: {
      signTransaction(input: {
        transaction: Uint8Array
        account: { address: string; chains: string[] }
      }): Promise<{ signature: Uint8Array } | Array<{ signature: Uint8Array }>>
    }
  }
}

/** Wallets to surface first. Everything else still shows, after these. */
const PRIORITY = ['phantom', 'solflare', 'backpack', 'metamask', 'coin98', 'trust']

export interface DiscoveredWallet {
  /** Stable key for React lists. */
  key: string
  name: string
  icon: string | null
  /** Lower sorts earlier. Non-prioritised wallets sort after. */
  rank: number
  wallet: PulseWallet
}

export interface ConnectedWallet {
  address: string
  publicKey: PublicKey
  displayName: string
  icon: string | null
  /**
   * Adapt this wallet to the `TxSigner` our transaction paths take. This is the
   * whole reason neither tx path contains wallet-specific code.
   */
  signer: TxSigner
}

function rankOf(name: string): number {
  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  const index = PRIORITY.findIndex((p) => key.includes(p))
  return index === -1 ? PRIORITY.length : index
}

/**
 * Narrow a registry entry to a Solana wallet that can actually sign.
 * Rejects anything without a `solana:signTransaction` feature, because offering
 * a connect button for a wallet that cannot sign is a dead end for the user.
 */
function toDiscovered(entry: unknown): DiscoveredWallet | null {
  if (typeof entry !== 'object' || entry === null) return null
  const w = entry as Partial<PulseWallet>

  if (typeof w.name !== 'string' || typeof w.version !== 'string') return null
  if (!Array.isArray(w.chains) || !w.chains.some((c: string) => c.startsWith('solana:'))) return null
  if (!Array.isArray(w.accounts)) return null
  if (!w.features || !w.features['solana:signTransaction']) return null

  return {
    key: `${w.name}:${w.version}`,
    name: w.name,
    icon: w.icon ?? null,
    rank: rankOf(w.name),
    wallet: w as PulseWallet,
  }
}

/** Adapt a Wallet Standard wallet to our `TxSigner`. */
function toSigner(wallet: PulseWallet, publicKey: PublicKey): TxSigner {
  return {
    publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      // The standard signs a serialised message and returns the bytes. We
      // serialise, hand over, and re-deserialise into the same concrete type.
      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      const feature = wallet.features['solana:signTransaction']
      if (!feature) throw new Error(`${wallet.name} cannot sign Solana transactions`)

      const response = await feature.signTransaction({
        transaction: serialized,
        account: { address: publicKey.toBase58(), chains: ['solana:mainnet'] },
      })
      const signed = Array.isArray(response) ? response[0]?.signature : response.signature
      if (!signed) throw new Error(`${wallet.name} did not return a signature`)

      if (tx instanceof VersionedTransaction) {
        return VersionedTransaction.deserialize(new Uint8Array(signed)) as T
      }
      // Legacy path. Pulse only builds v0 transactions today, but keep this
      // honest rather than silently mis-deserialising if that ever changes.
      return LegacyTransaction.from(new Uint8Array(signed)) as T
    },
  }
}

export interface UseWalletResult {
  /** Wallets found on this device/browser. Empty until discovery runs. */
  available: DiscoveredWallet[]
  connected: ConnectedWallet | null
  /** True while the registry is being read. */
  discovering: boolean
  /** True while a wallet's own modal is open. */
  connecting: boolean
  /** Populated when the wallet threw something that was not a user dismissal. */
  error: string | null
  /**
   * Connect a wallet. Resolves true when a usable account came back, false on
   * failure or dismissal — so a caller can keep a sheet open rather than closing
   * it on a rejection the user never saw the cause of.
   */
  connect: (target: DiscoveredWallet, options?: { silent?: boolean }) => Promise<boolean>
  disconnect: () => void
}

/**
 * Wallet connection state.
 *
 * Disconnection is driven by the user tapping disconnect, NOT by a
 * `standard:events` listener. On mobile the wallet app going to the background
 * routinely fires spurious change events, and dropping connection state halfway
 * through a buy is far worse than showing a stale wallet chip. Re-read the
 * account on the flows that matter instead.
 */
export function useWallet(rpcUrl: string): UseWalletResult {
  const [available, setAvailable] = useState<DiscoveredWallet[]>([])
  const [connected, setConnected] = useState<ConnectedWallet | null>(null)
  const [discovering, setDiscovering] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const run = () => {
      try {
        const found = getWallets()
          .get()
          .map(toDiscovered)
          .filter((w): w is DiscoveredWallet => w !== null)
          .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        if (!cancelled) setAvailable(found)
      } catch (err) {
        if (!cancelled) setError('Could not read installed wallets.')
        console.error('[wallet] discovery failed', err)
      } finally {
        if (!cancelled) setDiscovering(false)
      }
    }

    // One immediate pass, then two short retries: several wallets register late.
    run()
    const t1 = setTimeout(run, 250)
    const t2 = setTimeout(run, 900)
    return () => {
      cancelled = true
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  const connect = useCallback(async (target: DiscoveredWallet, options?: { silent?: boolean }): Promise<boolean> => {
    const silent = options?.silent === true
    setConnecting(true)
    if (!silent) setError(null)
    try {
      const connectFeature = target.wallet.features.connect
      if (!connectFeature) {
        // No connect feature means the wallet is either already authorised or
        // unusable. Try reading an account before giving up.
        if (target.wallet.accounts.length === 0) {
          throw new Error(`${target.name} cannot be connected from a browser.`)
        }
      } else {
        await connectFeature.connect()
      }

      const account = target.wallet.accounts[0]
      if (!account) throw new Error(`${target.name} returned no account.`)

      let publicKey: PublicKey
      try {
        publicKey = new PublicKey(account.address)
      } catch {
        throw new Error(`${target.name} returned an address that is not a valid Solana key.`)
      }

      setConnected({
        address: account.address,
        publicKey,
        displayName: target.name,
        icon: account.icon ?? target.icon,
        signer: toSigner(target.wallet, publicKey),
      })
      return true
    } catch (err) {
      // The overwhelmingly common cause is the user closing the wallet's own
      // modal. That is not an error worth shouting about.
      const message = err instanceof Error ? err.message : 'Could not connect that wallet.'
      const dismissed = /reject|cancel|denied|declined|user|closed/i.test(message)
      setError(dismissed || silent ? null : message)
      setConnected(null)
      return false
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    const entry = available.find((a) =>
      a.wallet.accounts.some((acc) => acc.address === connected?.address),
    )
    const disconnectFeature = entry?.wallet.features.disconnect
    if (disconnectFeature) {
      // Best-effort. Pulse keeps no server-side session, so there is nothing on
      // our side to clean up even if this fails.
      Promise.resolve(disconnectFeature.disconnect()).catch(() => {})
    }
    setConnected(null)
  }, [available, connected])

  return { available, connected, discovering, connecting, error, connect, disconnect }
}

/** A Connection pointed at the configured RPC, memoised. */
export function useConnection(rpcUrl: string): Connection {
  return useMemo(() => new Connection(rpcUrl, { commitment: 'confirmed' }), [rpcUrl])
}

/** `4Kp7…9xQm` — enough to recognise, not enough to be a phishing target. */
export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address
  return `${address.slice(0, lead)}…${address.slice(-tail)}`
}
