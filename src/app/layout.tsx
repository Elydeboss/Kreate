import type { Metadata, Viewport } from 'next'
import { Space_Grotesk, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Providers } from '@/lib/wallet/WalletProvider'

/**
 * Type: Space Grotesk for everything on screen, JetBrains Mono for every number.
 *
 * The mono font is not decoration. Prices, amounts, invite codes and signatures
 * are data, and data gets a data face: tabular, technical, unmistakably a readout.
 * The display face carries the voice — bold and slightly technical, the same
 * register as the product.
 */

const display = Space_Grotesk({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

const mono = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

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
    { media: '(prefers-color-scheme: light)', color: '#fafafc' },
    { media: '(prefers-color-scheme: dark)', color: '#1e2026' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}