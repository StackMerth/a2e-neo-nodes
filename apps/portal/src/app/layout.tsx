import type { Metadata, Viewport } from 'next'
import { Instrument_Sans, Inter, JetBrains_Mono } from 'next/font/google'
import '../globals.css'
import { Providers } from './providers'
import { CrispChat } from '@/components/CrispChat'
import { ThemeProvider } from '@/components/theme-provider'
import { ParticleBackground } from '@/components/ParticleBackground'

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
})

// Heavy Inter 900 for display headlines, matching the marketplace.
const interDisplay = Inter({
  subsets: ['latin'],
  weight: '900',
  variable: '--font-display',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'TokenOS DeAI Portal | TokenOS',
  description: 'Node Runner Portal for the TokenOS DeAI Arbitrage & Orchestration Engine',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${instrumentSans.variable} ${interDisplay.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans bg-background text-text-primary min-h-screen overflow-x-hidden">
        <ThemeProvider>
          {/* Particle field sits behind everything (z-0). Content
              still needs relative + z-10 wrappers to float on top.
              Layered approach lets us trial the v0-futuristic-dashboard
              look without rewriting every component yet. */}
          <ParticleBackground />
          <div className="relative z-10">
            <Providers>
              {children}
            </Providers>
            {/* M5.9 / D4: Crisp live chat. No-op when env var is unset. */}
            <CrispChat />
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
