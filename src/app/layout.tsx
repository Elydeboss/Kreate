import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Providers } from '@/lib/wallet/WalletProvider'

export const metadata: Metadata = {
  title: 'Pulse — social prediction markets',
  description:
    'Put your money where your mouth is, with your people. Live prediction markets powered by Panta on Solana.',
  // Wallet-first, no email, no signup. Nothing to leak.
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Do not cap zoom. Pinching to read a price is a failure.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfd' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1d22' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
