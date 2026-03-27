'use client'

import { useState, useRef, DragEvent, ChangeEvent } from 'react'

interface FileUploadProps {
  accept?: string
  maxSize?: number // in bytes
  onFileSelect: (file: File) => void
  onError?: (error: string) => void
  className?: string
  label?: string
  hint?: string
}

export function FileUpload({
  accept = '.csv',
  maxSize = 10 * 1024 * 1024, // 10MB default
  onFileSelect,
  onError,
  className = '',
  label = 'Upload file',
  hint = 'Drag and drop or click to select',
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const validateFile = (file: File): string | null => {
    if (accept) {
      const acceptedTypes = accept.split(',').map((t) => t.trim())
      const fileExtension = '.' + file.name.split('.').pop()?.toLowerCase()
      const isAccepted = acceptedTypes.some((type) => {
        if (type.startsWith('.')) return fileExtension === type.toLowerCase()
        if (type.includes('*')) return file.type.startsWith(type.split('*')[0])
        return file.type === type
      })
      if (!isAccepted) return `Invalid file type. Accepted: ${accept}`
    }
    if (file.size > maxSize) {
      return `File too large. Maximum size: ${(maxSize / 1024 / 1024).toFixed(1)}MB`
    }
    return null
  }

  const handleFile = (file: File) => {
    const error = validateFile(file)
    if (error) {
      onError?.(error)
      return
    }
    setSelectedFile(file)
    onFileSelect(file)
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  const handleClick = () => {
    inputRef.current?.click()
  }

  const handleRemove = () => {
    setSelectedFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
      />

      {selectedFile ? (
        <div className="flex items-center gap-3 p-4 bg-surface border border-border rounded-lg">
          <div className="flex-shrink-0 w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
            <FileIcon className="w-5 h-5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{selectedFile.name}</p>
            <p className="text-xs text-text-muted">
              {(selectedFile.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            className="p-2 text-text-muted hover:text-error hover:bg-error/10 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          onClick={handleClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg cursor-pointer transition-colors
            ${isDragging
              ? 'border-accent bg-accent/5'
              : 'border-border hover:border-accent/50 hover:bg-surface-hover'
            }
          `}
        >
          <UploadIcon className="w-10 h-10 text-text-muted mb-3" />
          <p className="text-sm font-medium text-text-primary">{label}</p>
          <p className="text-xs text-text-muted mt-1">{hint}</p>
          <p className="text-xs text-text-muted mt-2">
            Accepted: {accept} | Max: {(maxSize / 1024 / 1024).toFixed(0)}MB
          </p>
        </div>
      )}
    </div>
  )
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
    </svg>
  )
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}
