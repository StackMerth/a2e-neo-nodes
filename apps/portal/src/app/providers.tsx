'use client'

import { AuthProvider } from '@/hooks/useAuth'
import { ToastProvider } from '@/components/ui/Toast'
import { SidebarProvider } from '@/components/layout/SidebarContext'
import { WebSocketProvider } from '@/hooks/useWebSocket'
import { WalletContextProvider } from '@/components/wallet/WalletContextProvider'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {/* WebSocketProvider sits inside AuthProvider so it can read
          the current user; ToastProvider sits inside it so consumers
          using useWebSocket can fire toasts via the existing hook
          without a circular dependency.
          WalletContextProvider wraps Toast so the wallet-sign-to-pay
          flows can call toast() for success / error feedback. */}
      <WebSocketProvider>
        <SidebarProvider>
          <WalletContextProvider>
            <ToastProvider>
              {children}
            </ToastProvider>
          </WalletContextProvider>
        </SidebarProvider>
      </WebSocketProvider>
    </AuthProvider>
  )
}
