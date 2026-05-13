'use client'

import { useEffect, useState } from 'react'

/*
 * Loading screen shown by Next.js while a route transition is in
 * flight. Types the TokenOS_DeAI wordmark out and back in a loop
 * with a blinking caret, so it always reads as "actively loading"
 * regardless of how long the navigation takes.
 */
const TEXT = 'TokenOS_DeAI'
const SPLIT_INDEX = 7 // characters before "_DeAI"
const TYPE_SPEED_MS = 90
const PAUSE_FULL_MS = 1400
const ERASE_SPEED_MS = 55
const PAUSE_EMPTY_MS = 400

type Phase = 'typing' | 'pause-full' | 'erasing' | 'pause-empty'

export default function Loading() {
  const [displayed, setDisplayed] = useState('')
  const [phase, setPhase] = useState<Phase>('typing')

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>

    if (phase === 'typing') {
      if (displayed.length < TEXT.length) {
        timeout = setTimeout(() => setDisplayed(TEXT.slice(0, displayed.length + 1)), TYPE_SPEED_MS)
      } else {
        timeout = setTimeout(() => setPhase('pause-full'), 0)
      }
    } else if (phase === 'pause-full') {
      timeout = setTimeout(() => setPhase('erasing'), PAUSE_FULL_MS)
    } else if (phase === 'erasing') {
      if (displayed.length > 0) {
        timeout = setTimeout(() => setDisplayed(TEXT.slice(0, displayed.length - 1)), ERASE_SPEED_MS)
      } else {
        timeout = setTimeout(() => setPhase('pause-empty'), 0)
      }
    } else {
      timeout = setTimeout(() => setPhase('typing'), PAUSE_EMPTY_MS)
    }

    return () => clearTimeout(timeout)
  }, [displayed, phase])

  const baseChars = displayed.slice(0, SPLIT_INDEX)
  const brandChars = displayed.length > SPLIT_INDEX ? displayed.slice(SPLIT_INDEX) : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div
        aria-live="polite"
        className="font-display text-4xl sm:text-5xl lg:text-7xl tracking-tight flex items-center"
      >
        <span className="text-foreground">{baseChars}</span>
        <span className="text-brand">{brandChars}</span>
        <span className="ml-1 inline-block w-[3px] sm:w-[4px] h-[0.9em] bg-brand animate-pulse" />
      </div>
      <span className="sr-only">Loading TokenOS DeAI</span>
    </div>
  )
}
