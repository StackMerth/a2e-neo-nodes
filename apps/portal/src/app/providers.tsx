'use client'

import { AuthProvider } from '@/hooks/useAuth'
import { ToastProvider } from '@/components/ui/Toast'
import { SidebarProvider } from '@/components/layout/SidebarContext'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <SidebarProvider>
        <ToastProvider>
          {children}
        </ToastProvider>
      </SidebarProvider>
    </AuthProvider>
  )
}
