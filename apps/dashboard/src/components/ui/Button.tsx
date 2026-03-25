import { ReactNode } from 'react'

// =============================================================================
// BUTTON VARIANTS
// =============================================================================

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'danger'
  | 'ghost'
  | 'gradient'
  | 'gradient-blue'
  | 'gradient-purple'
  | 'gradient-outline'

type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'left' | 'right'
  glow?: boolean
  fullWidth?: boolean
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-background hover:bg-accent-hover hover:shadow-glow-accent',
  secondary:
    'bg-surface border border-border text-text-primary hover:bg-surface-hover hover:border-accent/30',
  outline:
    'border border-accent/50 text-accent bg-transparent hover:bg-accent/10 hover:border-accent',
  danger:
    'bg-error text-white hover:bg-red-600 hover:shadow-[0_0_20px_rgba(239,68,68,0.3)]',
  ghost:
    'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
  gradient:
    'bg-gradient-to-r from-accent to-accent-hover text-background hover:shadow-glow-accent hover:brightness-110',
  'gradient-blue':
    'bg-gradient-to-r from-accent-blue to-blue-600 text-white hover:shadow-glow-blue hover:brightness-110',
  'gradient-purple':
    'bg-gradient-to-r from-accent-purple to-purple-600 text-white hover:shadow-glow-purple hover:brightness-110',
  'gradient-outline':
    'relative bg-surface text-text-primary gradient-border hover:bg-surface-hover',
}

const sizeStyles: Record<ButtonSize, string> = {
  xs: 'px-3 py-1.5 text-xs gap-1.5',
  sm: 'px-4 py-2 text-xs gap-2',
  md: 'px-6 py-3 text-sm gap-2',
  lg: 'px-8 py-4 text-sm gap-3',
}

const iconSizeStyles: Record<ButtonSize, string> = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconPosition = 'left',
  glow = false,
  fullWidth = false,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const baseStyles = `
    inline-flex items-center justify-center
    font-semibold rounded-lg
    transition-all duration-300 ease-out
    focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-background
    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none
    uppercase tracking-wider
  `

  const glowStyles = glow ? 'shadow-glow-accent' : ''
  const widthStyles = fullWidth ? 'w-full' : ''

  const iconElement = icon && (
    <span className={iconSizeStyles[size]}>{icon}</span>
  )

  return (
    <button
      className={`
        ${baseStyles}
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${glowStyles}
        ${widthStyles}
        ${className}
      `}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Processing...
        </span>
      ) : (
        <>
          {iconPosition === 'left' && iconElement}
          {children}
          {iconPosition === 'right' && iconElement}
        </>
      )}
    </button>
  )
}

// =============================================================================
// ICON BUTTON - Compact button for icons only
// =============================================================================

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode
  variant?: 'default' | 'accent' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  tooltip?: string
  loading?: boolean
}

const iconButtonVariants = {
  default:
    'bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover hover:border-accent/30',
  accent:
    'bg-accent/10 border border-accent/20 text-accent hover:bg-accent/20 hover:border-accent/40',
  danger:
    'bg-error/10 border border-error/20 text-error hover:bg-error/20 hover:border-error/40',
  ghost:
    'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
}

const iconButtonSizes = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
}

const iconButtonIconSizes = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
}

export function IconButton({
  icon,
  variant = 'default',
  size = 'md',
  tooltip,
  loading = false,
  className = '',
  disabled,
  ...props
}: IconButtonProps) {
  return (
    <button
      className={`
        inline-flex items-center justify-center
        rounded-lg
        transition-all duration-300 ease-out
        focus:outline-none focus:ring-2 focus:ring-accent/50
        disabled:opacity-50 disabled:cursor-not-allowed
        ${iconButtonVariants[variant]}
        ${iconButtonSizes[size]}
        ${className}
      `}
      disabled={disabled || loading}
      title={tooltip}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
            fill="none"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        <span className={iconButtonIconSizes[size]}>{icon}</span>
      )}
    </button>
  )
}

// =============================================================================
// BUTTON GROUP - Group multiple buttons together
// =============================================================================

interface ButtonGroupProps {
  children: ReactNode
  className?: string
  attached?: boolean
}

export function ButtonGroup({
  children,
  className = '',
  attached = false,
}: ButtonGroupProps) {
  return (
    <div
      className={`
        inline-flex
        ${attached ? '[&>button]:rounded-none [&>button:first-child]:rounded-l-lg [&>button:last-child]:rounded-r-lg [&>button:not(:last-child)]:border-r-0' : 'gap-2'}
        ${className}
      `}
    >
      {children}
    </div>
  )
}
