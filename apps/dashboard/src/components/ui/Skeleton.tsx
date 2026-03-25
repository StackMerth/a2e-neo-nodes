// =============================================================================
// SKELETON LOADING COMPONENTS
// =============================================================================

interface SkeletonProps {
  className?: string
  style?: React.CSSProperties
}

// Base skeleton with shimmer animation
export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={`
        animate-shimmer bg-shimmer bg-[length:200%_100%]
        rounded-lg
        ${className}
      `}
      style={style}
    />
  )
}

// Skeleton for text lines
interface SkeletonTextProps {
  lines?: number
  className?: string
}

export function SkeletonText({ lines = 3, className = '' }: SkeletonTextProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-4 ${i === lines - 1 ? 'w-3/4' : 'w-full'}`}
        />
      ))}
    </div>
  )
}

// Skeleton for stat cards
export function SkeletonStatCard() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-start justify-between mb-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="h-10 w-32 mb-2" />
      <Skeleton className="h-4 w-24" />
    </div>
  )
}

// Skeleton for cards
interface SkeletonCardProps {
  hasHeader?: boolean
  lines?: number
}

export function SkeletonCard({ hasHeader = true, lines = 4 }: SkeletonCardProps) {
  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      {hasHeader && (
        <div className="mb-4">
          <Skeleton className="h-5 w-32 mb-2" />
          <Skeleton className="h-3 w-48" />
        </div>
      )}
      <SkeletonText lines={lines} />
    </div>
  )
}

// Skeleton for charts
export function SkeletonChart({ height = 200 }: { height?: number }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-5 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 rounded-lg" />
          <Skeleton className="h-8 w-16 rounded-lg" />
        </div>
      </div>
      <div style={{ height }} className="flex items-end justify-between gap-2 pt-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t-lg"
            style={{ height: `${30 + Math.random() * 60}%` }}
          />
        ))}
      </div>
    </div>
  )
}

// Skeleton for list items
export function SkeletonListItem() {
  return (
    <div className="flex items-center gap-4 p-4 border-b border-border last:border-0">
      <Skeleton className="h-10 w-10 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-6 w-16 rounded-full" />
    </div>
  )
}

// Skeleton for the entire overview page
export function SkeletonOverview() {
  return (
    <div className="space-y-8 animate-fade-in">
      {/* Hero */}
      <div className="text-center py-8">
        <Skeleton className="h-6 w-32 mx-auto mb-4 rounded-full" />
        <Skeleton className="h-10 w-64 mx-auto mb-2" />
        <Skeleton className="h-4 w-96 mx-auto" />
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>

      {/* Distribution Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <SkeletonCard lines={6} />
        <SkeletonCard lines={6} />
      </div>

      {/* Chart */}
      <SkeletonChart height={300} />

      {/* System Status Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SkeletonCard lines={5} />
        <div className="lg:col-span-2">
          <SkeletonCard lines={8} />
        </div>
      </div>
    </div>
  )
}

// Skeleton for table rows
export function SkeletonTableRow({ columns = 5 }: { columns?: number }) {
  return (
    <tr className="border-b border-border">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="py-4 px-4">
          <Skeleton className="h-4 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  )
}

// Skeleton for table
export function SkeletonTable({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border">
        <Skeleton className="h-5 w-32" />
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-surface-hover">
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="py-3 px-4 text-left">
                <Skeleton className="h-3 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonTableRow key={i} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
