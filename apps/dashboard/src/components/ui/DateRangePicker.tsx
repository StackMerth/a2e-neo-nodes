'use client'

import { useState, useRef, useEffect } from 'react'

interface DateRange {
  start: Date | null
  end: Date | null
}

interface DateRangePickerProps {
  value: DateRange
  onChange: (range: DateRange) => void
  presets?: Array<{ label: string; days: number }>
  className?: string
}

const defaultPresets = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
]

export function DateRangePicker({ value, onChange, presets = defaultPresets, className = '' }: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [tempStart, setTempStart] = useState<string>('')
  const [tempEnd, setTempEnd] = useState<string>('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (value.start) {
      setTempStart(value.start.toISOString().split('T')[0])
    }
    if (value.end) {
      setTempEnd(value.end.toISOString().split('T')[0])
    }
  }, [value])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handlePresetClick = (days: number) => {
    const end = new Date()
    const start = new Date()
    if (days > 0) {
      start.setDate(start.getDate() - days)
    }
    onChange({ start, end })
    setIsOpen(false)
  }

  const handleApply = () => {
    onChange({
      start: tempStart ? new Date(tempStart) : null,
      end: tempEnd ? new Date(tempEnd) : null,
    })
    setIsOpen(false)
  }

  const formatDisplayValue = () => {
    if (!value.start && !value.end) return 'Select date range'
    const startStr = value.start ? value.start.toLocaleDateString() : ''
    const endStr = value.end ? value.end.toLocaleDateString() : ''
    if (startStr === endStr) return startStr
    return `${startStr} - ${endStr}`
  }

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary hover:border-accent/50 transition-colors w-full"
      >
        <CalendarIcon className="w-4 h-4 text-text-muted" />
        <span className="flex-1 text-left truncate">{formatDisplayValue()}</span>
        <ChevronIcon className={`w-4 h-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-72 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Presets */}
          <div className="p-2 border-b border-border">
            <p className="text-xs text-text-muted px-2 mb-2">Quick select</p>
            <div className="flex flex-wrap gap-1">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handlePresetClick(preset.days)}
                  className="px-3 py-1 text-xs bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-md transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Range */}
          <div className="p-3">
            <p className="text-xs text-text-muted mb-2">Custom range</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Start</label>
                <input
                  type="date"
                  value={tempStart}
                  onChange={(e) => setTempStart(e.target.value)}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-text-primary"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">End</label>
                <input
                  type="date"
                  value={tempEnd}
                  onChange={(e) => setTempEnd(e.target.value)}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-text-primary"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="flex-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                className="flex-1 px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}
