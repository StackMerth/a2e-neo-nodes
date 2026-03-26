interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export function Input({ label, error, icon, className = '', ...props }: InputProps) {
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
          className={`
            w-full px-4 py-2 bg-background border border-border rounded-lg
            text-text-primary placeholder-text-muted
            focus:border-accent focus:ring-1 focus:ring-accent
            transition-colors
            ${icon ? 'pl-10' : ''}
            ${error ? 'border-error' : ''}
            ${className}
          `}
          {...props}
        />
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
        className={`w-full px-4 py-2 bg-background border border-border rounded-lg text-text-primary focus:border-accent focus:ring-1 focus:ring-accent transition-colors ${className}`}
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
