import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'A²E Compute Marketplace',
  description: 'Discover GPU compute operators on the A²E network. Browse reputation, uptime, and ratings before you rent.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
