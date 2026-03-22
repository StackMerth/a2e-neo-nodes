import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '../globals.css'
import { Header } from '@/components/layout/Header'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'A²E Dashboard | TokenOS',
  description: 'Admin dashboard for the A²E Arbitrage & Orchestration Engine',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-text-primary min-h-screen`}>
        <Header />
        <main className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </main>
        <footer className="border-t border-border mt-16 py-8">
          <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
            <div>
              <p className="text-sm text-text-muted">A²E Engine</p>
              <p className="text-xs text-text-muted mt-1">Arbitrage & Orchestration for TokenOS</p>
            </div>
            <div className="flex items-center gap-4 text-text-muted">
              <a href="https://compute.tokenos.ai" target="_blank" rel="noopener" className="text-sm hover:text-accent transition-colors">
                TokenOS
              </a>
              <a href="https://a2e.byredstone.com/health" target="_blank" rel="noopener" className="text-sm hover:text-accent transition-colors">
                API Status
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
}
