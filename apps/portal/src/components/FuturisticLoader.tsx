'use client'

/*
 * Concentric rotating rings loader ported from
 * StackMerth/v0-futuristic-dashboard. Five rings, each rotating at a
 * different speed and tied to a different brand colour. "SYSTEM
 * INITIALIZING" mono caption underneath. Designed to fill the
 * viewport with a black/80 backdrop while shown.
 */

export function FuturisticLoader({
  caption = 'INITIALIZING',
}: {
  caption?: string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="flex flex-col items-center">
        <div className="relative w-24 h-24">
          <div className="absolute inset-0 border-4 border-cyan-500/30 rounded-full animate-ping" />
          <div className="absolute inset-2 border-4 border-t-cyan-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin" />
          <div
            className="absolute inset-4 border-4 border-r-purple-500 border-t-transparent border-b-transparent border-l-transparent rounded-full animate-spin"
            style={{ animationDuration: '3s' }}
          />
          <div
            className="absolute inset-6 border-4 border-b-blue-500 border-t-transparent border-r-transparent border-l-transparent rounded-full animate-spin"
            style={{ animationDuration: '4.5s' }}
          />
          <div className="absolute inset-8 border-4 border-l-green-500 border-t-transparent border-r-transparent border-b-transparent rounded-full animate-spin" />
        </div>
        <div className="mt-4 text-cyan-500 font-mono text-sm tracking-[0.18em]">
          {caption}
        </div>
      </div>
    </div>
  )
}
