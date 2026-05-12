import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import '../globals.css'
import { Providers } from './providers'
import { CrispChat } from '@/components/CrispChat'

const inter = Inter({ subsets: ['latin'] })

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
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-text-primary min-h-screen`}>
        <Providers>
          {children}
        </Providers>
        {/* M5.9 / D4: Crisp live chat. No-op when env var is unset. */}
        <CrispChat />
      </body>
    </html>
  )
}
