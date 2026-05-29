'use client'

/**
 * T2.1 toast redesign (admin dashboard).
 *
 * Matches the portal's new toast UX: top-center placement, color-coded
 * left accent strip, icon + label + body, click anywhere to dismiss.
 * Preserves the dashboard-specific API surface (addToast accepts an
 * optional title alongside the message) so existing call sites in
 * payments/withdrawals/etc. work unchanged.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: string
  type: ToastType
  message: string
  title?: string
}

interface ToastContextType {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

const AUTO_DISMISS_MS = 5000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(7)
    setToasts((prev) => [...prev, { ...toast, id }])
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 inset-x-0 z-[9999] flex flex-col items-center gap-2 pointer-events-none px-4">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  )
}

const TONE = {
  success: {
    accent: 'rgb(34, 197, 94)',
    icon: CheckCircle2,
    label: 'Success',
  },
  error: {
    accent: 'rgb(239, 68, 68)',
    icon: AlertCircle,
    label: 'Error',
  },
  info: {
    accent: 'rgb(59, 130, 246)',
    icon: Info,
    label: 'Notice',
  },
  warning: {
    accent: 'rgb(234, 179, 8)',
    icon: AlertTriangle,
    label: 'Heads up',
  },
} as const

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [mounted, setMounted] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
    const timer = setTimeout(() => {
      setLeaving(true)
      setTimeout(() => onRemove(toast.id), 200)
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [onRemove, toast.id])

  const meta = TONE[toast.type]
  const Icon = meta.icon

  const dismiss = () => {
    setLeaving(true)
    setTimeout(() => onRemove(toast.id), 200)
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      onClick={dismiss}
      className="pointer-events-auto cursor-pointer w-full max-w-md rounded-xl shadow-2xl overflow-hidden flex items-stretch"
      style={{
        background: 'rgba(15, 17, 22, 0.96)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(20px)',
        transform: leaving ? 'translateY(-12px)' : mounted ? 'translateY(0)' : 'translateY(-32px)',
        opacity: leaving ? 0 : mounted ? 1 : 0,
        transition: 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out',
      }}
    >
      <div className="shrink-0 w-1" style={{ background: meta.accent }} />
      <div className="flex items-start gap-3 flex-1 px-4 py-3.5">
        <div
          className="shrink-0 mt-0.5 rounded-full p-1.5"
          style={{ background: `${meta.accent}1a`, color: meta.accent }}
        >
          <Icon size={16} strokeWidth={2.4} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] font-mono opacity-70" style={{ color: meta.accent }}>
            {toast.title ?? meta.label}
          </div>
          <div className="text-sm leading-snug mt-0.5 text-white">
            {toast.message}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            dismiss()
          }}
          aria-label="Dismiss"
          className="shrink-0 -mr-1 -mt-1 p-1 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
