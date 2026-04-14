import { type HTMLAttributes, type ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  hover?: boolean
}

export function Card({ children, hover = false, className = '', ...props }: CardProps) {
  return (
    <div
      className={`bg-surface border border-border rounded-xl p-6 ${hover ? 'hover:border-accent/30 hover:shadow-card-hover transition-all duration-200' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}
