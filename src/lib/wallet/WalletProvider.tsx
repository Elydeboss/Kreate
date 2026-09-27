'use client'

/**
 * Wallet connection, as app-wide context.
 *
 * The hook in ./useWallet owns the mechanics — discovery, connecting, adapting to
 * a `TxSigner`. This owns the *sharing*, because a connection is needed by the
 * header, the room, the create sheet, and the buy sheet, and re-deriving it in
 * each of those would mean four Wallet Standard registries and four chances to
 * disagree about which account is active.
 *
 * Deliberately stores nothing. No localStorage, no cookie, no server session.
 * Wallets remember their own authorisation, so on a return visit the registry
 * still reports the account and `autoConnect` picks it up. Persisting the
 * address ourselves would only add a stale-value failure mode on top of a
 * mechanism that already works.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { clientConfig } from '@/lib/client/config'
import { useWallet, type ConnectedWallet, type DiscoveredWallet } from './useWallet'

interface WalletContextValue {
  connected: ConnectedWallet | null
  available: DiscoveredWallet[]
  discovering: boolean
  connecting: boolean
  error: string | null
  connect: (target: DiscoveredWallet, options?: { silent?: boolean }) => Promise<boolean>
  disconnect: () => void
}

const WalletContext = createContext<WalletContextValue | null>(null)

/**
 * React Query defaults, tuned for a live room.
 *
 * `refetchOnWindowFocus: false` matters more than it looks. A watch party runs
 * in a tab that people switch away from and back to constantly, and every
 * refocus would otherwise fire a burst of price reads against a 120/min budget
 * shared by every user on the key. Polling already covers freshness.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // Never retry a 4xx. A rejected order or an expired quote will fail
          // identically on the second attempt, and retrying spends rate budget
          // to produce the same error.
          const status = (error as { status?: number } | null)?.status
          if (typeof status === 'number' && status >= 400 && status < 500) return false
          return failureCount < 2
        },
      },
    },
  })
}

export function Providers({ children }: { children: ReactNode }) {
  // Created once per browser session, not per render. A QueryClient rebuilt on
  // every render discards the entire cache, which for a live-price app means the
  // screen flashes empty on every parent update.
  const [queryClient] = useState(makeQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProviderInner>{children}</WalletProviderInner>
    </QueryClientProvider>
  )
}

function WalletProviderInner({ children }: { children: ReactNode }) {
  const wallet = useWallet(clientConfig.rpcUrl)
  const attempted = useRef(false)

  /**
   * Pick up an already-authorised wallet on load.
   *
   * Wallets keep authorisation between visits, so a returning user arrives with
   * accounts already present. Connecting them automatically is what makes the
   * second visit feel instant instead of asking for a tap they have already made
   * a hundred times.
   *
   * Only fires when there is no connected wallet, only once, and only for a
   * wallet that has accounts *and* a connect feature — the latter means the
   * wallet is treating authorisation as a real grant rather than being open.
   *
   * The connect is `silent`. Nobody asked for it, so a failure is not something
   * to put an error banner in front of them over.
   */
  useEffect(() => {
    if (attempted.current) return
    if (wallet.connected) {
      attempted.current = true
      return
    }
    if (wallet.discovering) return

    const candidate = wallet.available.find(
      (w) => w.wallet.accounts.length > 0 && w.wallet.features.connect,
    )
    attempted.current = true
    if (!candidate) return

    void wallet.connect(candidate, { silent: true })
  }, [wallet])

  const value = useMemo<WalletContextValue>(
    () => ({
      connected: wallet.connected,
      available: wallet.available,
      discovering: wallet.discovering,
      connecting: wallet.connecting,
      error: wallet.error,
      connect: wallet.connect,
      disconnect: wallet.disconnect,
    }),
    [wallet],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWalletContext must be used inside <Providers>')
  return ctx
}
