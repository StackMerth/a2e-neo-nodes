'use client'

/*
 * Admin loading screen. Replaces the small spinner shown by
 * AuthenticatedLayout while the auth context resolves.
 *
 * Visual: typewriter effect on the brand wordmark - TokenOS in
 * primary text color, _DeAI in primary green, Admin in muted. A
 * blinking primary-green block cursor follows the last revealed
 * character. After the full text reveals it pauses ~1.2s then
 * resets and types again, so the user always sees motion regardless
 * of how long the auth resolves.
 *
 * No shell wrapper: pure text centered on the admin's dark canvas.
 */

import { useEffect, useState } from 'react'

const SEGMENTS: Array<{ text: string; color: string }> = [
  { text: 'TokenOS', color: 'var(--text-primary)' },
  { text: '_DeAI',   color: 'var(--primary)' },
  { text: ' Admin',  color: 'var(--text-muted)' },
]

const FULL_LENGTH = SEGMENTS.reduce((sum, s) => sum + s.text.length, 0)
const TYPE_INTERVAL_MS = 85
const PAUSE_AT_END_MS  = 1200
const PAUSE_AT_START_MS = 400

export function AdminLoadingScreen() {
  const [revealed, setRevealed] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const step = (pos: number) => {
      if (pos > FULL_LENGTH) {
        timer = setTimeout(() => {
          setRevealed(0)
          timer = setTimeout(() => step(1), PAUSE_AT_START_MS)
        }, PAUSE_AT_END_MS)
        return
      }
      setRevealed(pos)
      timer = setTimeout(() => step(pos + 1), TYPE_INTERVAL_MS)
    }
    step(1)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Track absolute character index across segments so each character
  // can decide whether it's been revealed.
  let absoluteIdx = 0

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: 'var(--bg-dark)' }}
    >
      <div
        className="font-display tracking-tight inline-flex items-baseline"
        style={{
          fontSize: 'clamp(2rem, 6vw, 4.5rem)',
          fontWeight: 900,
          letterSpacing: '-0.03em',
          lineHeight: 1,
        }}
      >
        {SEGMENTS.map((segment, si) => (
          <span key={si} style={{ color: segment.color }}>
            {segment.text.split('').map((ch) => {
              const myIdx = absoluteIdx++
              const visible = revealed > myIdx
              return (
                <span
                  key={myIdx}
                  style={{
                    opacity: visible ? 1 : 0,
                    transition: 'opacity 60ms ease-out',
                    whiteSpace: 'pre',
                  }}
                >
                  {ch}
                </span>
              )
            })}
          </span>
        ))}
        {/* Cursor: green block that blinks. Sits at the current type
            position so it follows the reveal naturally. */}
        <span
          aria-hidden
          className="ml-2 inline-block animate-pulse"
          style={{
            width: '0.18em',
            height: '0.85em',
            background: 'var(--primary)',
            borderRadius: 2,
            verticalAlign: 'baseline',
          }}
        />
      </div>
    </div>
  )
}
