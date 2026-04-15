'use client'

import { ReactNode } from 'react'
import { WebSocketProvider } from '@/hooks/useWebSocket'
import { AuthProvider } from '@/hooks/useAuth'
import { ToastProvider } from '@/components/ui/Toast'
import { SidebarProvider } from '@/components/layout/SidebarContext'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <SidebarProvider>
        <ToastProvider>
          <WebSocketProvider>
            {children}
          </WebSocketProvider>
        </ToastProvider>
      </SidebarProvider>
    </AuthProvider>
  )
}
