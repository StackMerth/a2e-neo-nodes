/**
 * Marketplace home — placeholder until M5 builds out the full catalog
 * (filterable listings, leaderboard, OG cards, SEO). For M3 the only
 * functional route is /operator/[slug]; this page just orients
 * visitors who land at the root.
 */
export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-2xl text-center">
        <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
          A²E Compute Marketplace
        </h1>
        <p className="text-lg mb-8" style={{ color: 'var(--text-secondary)' }}>
          Public operator profiles and reputation. Full marketplace catalog launches in M5.
        </p>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Looking for an operator? Visit <code className="font-mono">/operator/&lt;slug&gt;</code>.
        </p>
      </div>
    </main>
  )
}
