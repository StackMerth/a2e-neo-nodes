'use client'

/**
 * T2.1 toast redesign.
 *
 * Old behavior: bottom-right corner, narrow card, easily missed and
 * sometimes obscured by the cancel/action buttons of an open modal
 * (caught the WrongSize error in the Solana topup modal). New
 * behavior: top-center, wider with clear icon + title + body, left
 * accent strip color-coded by type, dedicated close button, click
 * anywhere on the body to dismiss. Slide-down animation from above.
 *
 * Shared component — every page that uses useToast gets the new UI
 * automatically. Both portal and dashboard have their own copies of
 * this file with the same shape so notifications feel uniform across
 * buyer + node-runner surfaces.
 */

import {
  useState,
  useEffect,
  createContext,
  useContext,
  useCallback,
  type ReactNode,
} from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: string
  type: ToastType
  message: string
}

interface ToastContextType {
  toast: (type: ToastType, message: string) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

const AUTO_DISMISS_MS = 5000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev, { id, type, message }])
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div
        className="fixed top-4 inset-x-0 flex flex-col items-center gap-2 pointer-events-none px-4"
        style={{
          // Inline max-int z-index instead of Tailwind arbitrary class.
          // Tailwind's z-[9999] worked but the topup modal's card sits
          // at z-150 in its own stacking context — in some browsers
          // arbitrary classes have been observed to render at a lower
          // effective layer than inline z-index when fighting nested
          // stacking contexts. Inline wins unconditionally.
          zIndex: 2147483647,
        }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
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

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
    const timer = setTimeout(() => {
      setLeaving(true)
      setTimeout(onDismiss, 200)
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const meta = TONE[toast.type]
  const Icon = meta.icon

  const dismiss = () => {
    setLeaving(true)
    setTimeout(onDismiss, 200)
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      onClick={dismiss}
      className="pointer-events-auto cursor-pointer w-full max-w-2xl rounded-xl shadow-2xl flex items-stretch"
      style={{
        background: 'rgba(15, 17, 22, 0.96)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(20px)',
        transform: leaving ? 'translateY(-12px)' : mounted ? 'translateY(0)' : 'translateY(-32px)',
        opacity: leaving ? 0 : mounted ? 1 : 0,
        transition: 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out',
        // Removed overflow-hidden + max-w-md. Long unbroken strings
        // (Solana signatures, URLs) were being clipped on the right
        // edge instead of wrapping. Bumped max-w to 2xl (672px) so
        // multi-line messages have room without ballooning past the
        // viewport on mobile.
      }}
    >
      <div className="shrink-0 w-1 rounded-l-xl" style={{ background: meta.accent }} />
      <div className="flex items-start gap-3 flex-1 px-4 py-3.5 min-w-0">
        <div
          className="shrink-0 mt-0.5 rounded-full p-1.5"
          style={{ background: `${meta.accent}1a`, color: meta.accent }}
        >
          <Icon size={16} strokeWidth={2.4} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] font-mono opacity-70" style={{ color: meta.accent }}>
            {meta.label}
          </div>
          {/* break-words wraps long words at any character. Critical
              for Solana signatures (88-char base58 strings) and URLs
              that would otherwise overflow horizontally and get
              clipped. whitespace-pre-wrap preserves user-inserted
              line breaks in error messages. */}
          <div
            className="text-sm leading-snug mt-0.5 text-white break-words whitespace-pre-wrap"
            style={{ wordBreak: 'break-word' }}
          >
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

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
