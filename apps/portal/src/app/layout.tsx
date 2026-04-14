import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '../globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'A²E Portal | TokenOS',
  description: 'Node Runner Portal for the A²E Arbitrage & Orchestration Engine',
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
      </body>
    </html>
  )
}
