'use client'

/*
 * Canvas-based particle field ported from StackMerth/v0-futuristic-dashboard.
 * 100 slow-drifting cyan/blue dots over the viewport. Mounts as a fixed
 * background layer so every page floats on it. opacity-30 keeps it subtle
 * enough not to fight the foreground content.
 */

import { useEffect, useRef } from 'react'

export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    type Particle = {
      x: number
      y: number
      size: number
      sx: number
      sy: number
      color: string
    }

    const particles: Particle[] = []
    const particleCount = 100

    const makeParticle = (): Particle => {
      const rect = canvas.getBoundingClientRect()
      const r = Math.floor(Math.random() * 100) + 100
      const g = Math.floor(Math.random() * 100) + 150
      const b = Math.floor(Math.random() * 55) + 200
      const a = Math.random() * 0.5 + 0.2
      return {
        x: Math.random() * rect.width,
        y: Math.random() * rect.height,
        size: Math.random() * 3 + 1,
        sx: (Math.random() - 0.5) * 0.5,
        sy: (Math.random() - 0.5) * 0.5,
        color: `rgba(${r}, ${g}, ${b}, ${a})`,
      }
    }

    for (let i = 0; i < particleCount; i++) particles.push(makeParticle())

    let frameId = 0
    const tick = () => {
      const rect = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, rect.width, rect.height)
      for (const p of particles) {
        p.x += p.sx
        p.y += p.sy
        if (p.x > rect.width) p.x = 0
        if (p.x < 0) p.x = rect.width
        if (p.y > rect.height) p.y = 0
        if (p.y < 0) p.y = rect.height
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fill()
      }
      frameId = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 w-full h-full pointer-events-none opacity-30"
      style={{ zIndex: 0 }}
    />
  )
}
