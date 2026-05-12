import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { RefCapture } from '@/components/landing/ref-capture'

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument-serif',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
})

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://marketplace.stackforgelab.tech'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'A2E Compute Marketplace',
    template: '%s, A2E',
  },
  description: 'Browse GPU compute operators on the A2E network. Reputation, uptime, and ratings before you rent.',
  openGraph: {
    type: 'website',
    siteName: 'A2E',
    title: 'GPU compute, brokered honestly',
    description: 'Per-minute billing, reputation-scored operators, SSH under a minute.',
    images: [
      {
        url: '/og?type=home',
        width: 1200,
        height: 630,
        alt: 'A2E Compute Marketplace',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GPU compute, brokered honestly',
    description: 'Per-minute billing, reputation-scored operators, SSH under a minute.',
    images: ['/og?type=home'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased">
        {/* M5.7 polish: capture ?ref=CODE from share links and rewrite
            portal-signup hrefs so the code rides across the domain hop. */}
        <Suspense fallback={null}>
          <RefCapture />
        </Suspense>
        {children}
      </body>
    </html>
  )
}
