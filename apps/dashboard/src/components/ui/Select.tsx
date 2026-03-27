'use client'

import { useState, useRef, useEffect, ReactNode } from 'react'

interface Option {
  value: string
  label: string
  icon?: ReactNode
}

interface SelectProps {
  options: Option[]
  value: string | string[]
  onChange: (value: string | string[]) => void
  placeholder?: string
  multiple?: boolean
  searchable?: boolean
  className?: string
  disabled?: boolean
}

export function Select({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  multiple = false,
  searchable = false,
  className = '',
  disabled = false,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedValues = Array.isArray(value) ? value : value ? [value] : []

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (isOpen && searchable && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen, searchable])

  const filteredOptions = options.filter((opt) =>
    opt.label.toLowerCase().includes(search.toLowerCase())
  )

  const handleSelect = (optionValue: string) => {
    if (multiple) {
      const newValue = selectedValues.includes(optionValue)
        ? selectedValues.filter((v) => v !== optionValue)
        : [...selectedValues, optionValue]
      onChange(newValue)
    } else {
      onChange(optionValue)
      setIsOpen(false)
    }
    setSearch('')
  }

  const handleRemove = (optionValue: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (multiple) {
      onChange(selectedValues.filter((v) => v !== optionValue))
    }
  }

  const getDisplayValue = () => {
    if (selectedValues.length === 0) return placeholder
    if (!multiple) {
      return options.find((o) => o.value === selectedValues[0])?.label || placeholder
    }
    return null
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-2 w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-left
          transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-accent/50 cursor-pointer'}
          ${isOpen ? 'border-accent ring-1 ring-accent/20' : ''}
        `}
      >
        <div className="flex-1 flex flex-wrap gap-1 min-h-[20px]">
          {multiple && selectedValues.length > 0 ? (
            selectedValues.map((val) => {
              const option = options.find((o) => o.value === val)
              return (
                <span
                  key={val}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent rounded text-xs"
                >
                  {option?.label}
                  <button
                    type="button"
                    onClick={(e) => handleRemove(val, e)}
                    className="hover:bg-accent/20 rounded-full p-0.5"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )
            })
          ) : (
            <span className={selectedValues.length === 0 ? 'text-text-muted' : 'text-text-primary'}>
              {getDisplayValue()}
            </span>
          )}
        </div>
        <ChevronIcon className={`w-4 h-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          {searchable && (
            <div className="p-2 border-b border-border">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full px-3 py-1.5 bg-background border border-border rounded text-sm text-text-primary focus:outline-none focus:border-accent"
              />
            </div>
          )}

          <div className="max-h-60 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-text-muted text-center">
                No options found
              </div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = selectedValues.includes(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSelect(option.value)}
                    className={`
                      w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors
                      ${isSelected
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-primary hover:bg-surface-hover'
                      }
                    `}
                  >
                    {multiple && (
                      <span className={`
                        w-4 h-4 border rounded flex items-center justify-center
                        ${isSelected ? 'bg-accent border-accent' : 'border-border'}
                      `}>
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                    )}
                    {option.icon}
                    <span className="flex-1">{option.label}</span>
                    {!multiple && isSelected && (
                      <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}
