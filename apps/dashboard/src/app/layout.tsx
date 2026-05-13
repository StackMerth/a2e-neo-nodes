import type { Metadata, Viewport } from 'next'
import { Instrument_Sans, Inter, JetBrains_Mono } from 'next/font/google'
import '../globals.css'
import { Providers } from '@/components/Providers'
import { AuthenticatedLayout } from '@/components/layout/AuthenticatedLayout'
import { ThemeProvider } from '@/components/theme-provider'

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
  title: 'TokenOS DeAI Dashboard | TokenOS',
  description: 'Admin dashboard for the TokenOS DeAI Arbitrage & Orchestration Engine',
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
      <body className="font-sans bg-background text-text-primary min-h-screen">
        <ThemeProvider>
          <Providers>
            <AuthenticatedLayout>
              {children}
            </AuthenticatedLayout>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
