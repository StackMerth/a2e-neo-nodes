'use client'

import { type InputHTMLAttributes, forwardRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', type, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false)
    const isPassword = type === 'password'
    const effectiveType = isPassword && showPassword ? 'text' : type

    return (
      <div className="space-y-1.5">
        {label && (
          <label className="block text-sm font-medium text-text-secondary">{label}</label>
        )}
        <div className="relative">
          <input
            ref={ref}
            type={effectiveType}
            className={`w-full bg-surface border border-border rounded-lg px-4 py-2.5 ${isPassword ? 'pr-11' : ''} text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors ${error ? 'border-error' : ''} ${className}`}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          )}
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    )
  }
)
Input.displayName = 'Input'
