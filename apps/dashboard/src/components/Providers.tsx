'use client'

import { ReactNode } from 'react'
import { WebSocketProvider } from '@/hooks/useWebSocket'
import { AuthProvider } from '@/hooks/useAuth'
import { ToastProvider } from '@/components/ui/Toast'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <WebSocketProvider>
          {children}
        </WebSocketProvider>
      </ToastProvider>
    </AuthProvider>
  )
}
