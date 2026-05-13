import type { Metadata, Viewport } from 'next'
import { Suspense } from 'react'
import { Instrument_Sans, Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { RefCapture } from '@/components/landing/ref-capture'
import { MarketplaceChat } from '@/components/landing/marketplace-chat'
import { ThemeProvider } from '@/components/theme-provider'

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
})

// Heavy Inter at weight 900 powers all display headlines. Matches
// the chunky enterprise feel of the old TokenOS_COMPUTE wordmark
// instead of the editorial Instrument Serif we started with.
const interDisplay = Inter({
  subsets: ['latin'],
  weight: '900',
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
    default: 'TokenOS Compute Marketplace',
    template: '%s, TokenOS',
  },
  description: 'Discover GPU compute operators on the TokenOS network. Browse reputation, uptime, and ratings before you rent.',
  openGraph: {
    type: 'website',
    siteName: 'TokenOS',
    title: 'TokenOS Compute Marketplace',
    description: 'Discover GPU compute operators on the TokenOS network. Browse reputation, uptime, and ratings before you rent.',
    images: [
      {
        url: '/og?type=home',
        width: 1200,
        height: 630,
        alt: 'TokenOS Compute Marketplace',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TokenOS Compute Marketplace',
    description: 'Discover GPU compute operators on the TokenOS network. Browse reputation, uptime, and ratings before you rent.',
    images: ['/og?type=home'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${instrumentSans.variable} ${interDisplay.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider>
          {/* M5.7 polish: capture ?ref=CODE from share links and rewrite
              portal-signup hrefs so the code rides across the domain hop. */}
          <Suspense fallback={null}>
            <RefCapture />
          </Suspense>
          {children}
          {/* Always-on chat assistant backed by Claude Haiku 4.5. */}
          <MarketplaceChat />
        </ThemeProvider>
      </body>
    </html>
  )
}
