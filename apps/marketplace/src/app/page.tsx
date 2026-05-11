import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-3xl text-center space-y-10">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          A2E Compute Marketplace
        </p>
        <h1 className="font-display text-5xl md:text-7xl leading-[1.05] text-foreground">
          GPU compute, brokered honestly.
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Browse operators, check uptime and ratings, and rent on terms you can read in one breath.
          The full catalog and leaderboard land next.
        </p>
        <div className="flex items-center justify-center gap-3 pt-4">
          <Button variant="outline" size="lg" asChild>
            <Link href="/operator/seed-runner-1">View a sample operator</Link>
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground pt-6">
          Operator profiles live at <span className="text-foreground">/operator/&lt;slug&gt;</span>
        </p>
      </div>
    </main>
  )
}
