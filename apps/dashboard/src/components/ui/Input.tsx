'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export function Input({ label, error, icon, className = '', type, ...props }: InputProps) {
  const [showPassword, setShowPassword] = useState(false)
  const isPassword = type === 'password'
  const effectiveType = isPassword && showPassword ? 'text' : type

  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-sm font-medium text-text-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
            {icon}
          </div>
        )}
        <input
          type={effectiveType}
          className={`
            w-full px-4 py-2.5 rounded-lg
            text-text-primary placeholder-text-muted
            focus:ring-1 focus:ring-accent
            transition-colors
            ${icon ? 'pl-10' : ''}
            ${isPassword ? 'pr-11' : ''}
            ${error ? 'border-error' : ''}
            ${className}
          `}
          style={{
            background: 'var(--bg-card)',
            border: `1px solid ${error ? 'var(--error)' : 'var(--border-color)'}`,
            color: 'var(--text-primary)',
          }}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
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

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  options: Array<{ value: string; label: string }>
}

export function Select({ label, options, className = '', ...props }: SelectProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-sm font-medium text-text-secondary">
          {label}
        </label>
      )}
      <select
        className={`w-full px-4 py-2.5 rounded-lg text-text-primary focus:ring-1 focus:ring-accent transition-colors ${className}`}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
