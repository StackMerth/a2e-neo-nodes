/*
 * M5.4: dynamic Open Graph card generator.
 *
 * GET /og?type=home
 * GET /og?type=operator&slug=<slug>
 * GET /og?type=marketplace
 * GET /og?type=leaderboard
 *
 * Renders 1200x630 PNG via Next.js's built-in ImageResponse (Satori under
 * the hood). Light-mode editorial palette: cream background, deep ink
 * type, Instrument Serif headlines, JetBrains Mono for numerics and
 * labels. No glow, no decorative chips, matches the page aesthetic.
 *
 * Operator cards fetch the public profile so the OG image shows the
 * operator name, tier, score, and node count.
 */
import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

export const runtime = 'edge'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

const COLORS = {
  bg: '#FBFAF6',
  ink: '#1A1A18',
  muted: '#6B6B68',
  hairline: '#E0DFD9',
}

type ReputationTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'

interface OperatorPublicData {
  name: string
  slug: string
  reputationScore: number
  reputationTier: ReputationTier
  uptimePercent30d: number | null
  totalCompletedJobs: number
  nodes: Array<{ gpuTier: string }>
}

async function fetchOperator(slug: string): Promise<OperatorPublicData | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/operators/${slug}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as OperatorPublicData
  } catch {
    return null
  }
}

function humanRep(t: ReputationTier): string {
  return t.charAt(0) + t.slice(1).toLowerCase()
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') ?? 'home'

  if (type === 'operator') {
    const slug = searchParams.get('slug')
    if (!slug) return renderHome('Operator not specified')
    const op = await fetchOperator(slug)
    if (!op) return renderHome('Operator not found')
    return renderOperator(op)
  }
  if (type === 'marketplace') {
    return renderTitled('GPU inventory, live.', 'Pick a tier, filter by region, see what is on right now.')
  }
  if (type === 'leaderboard') {
    return renderTitled('Earned, not bought.', 'Operators ranked by uptime, ratings, and completed jobs.')
  }
  return renderHome()
}

function renderHome(subtitle?: string): ImageResponse {
  return new ImageResponse(
    (
      <div style={baseFrame}>
        <Header />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={eyebrow}>The marketplace for GPU compute</div>
          <div style={{ ...headline, fontSize: 88 }}>GPU compute,</div>
          <div style={{ ...headline, fontSize: 88 }}>brokered honestly.</div>
          {subtitle && <div style={subhead}>{subtitle}</div>}
        </div>
        <Footer />
      </div>
    ),
    { width: 1200, height: 630 },
  )
}

function renderTitled(title: string, subtitle: string): ImageResponse {
  return new ImageResponse(
    (
      <div style={baseFrame}>
        <Header />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={eyebrow}>tokenos deai network</div>
          <div style={{ ...headline, fontSize: 96 }}>{title}</div>
          <div style={subhead}>{subtitle}</div>
        </div>
        <Footer />
      </div>
    ),
    { width: 1200, height: 630 },
  )
}

function renderOperator(op: OperatorPublicData): ImageResponse {
  const gpuTiers = Array.from(new Set(op.nodes.map((n) => n.gpuTier)))
  return new ImageResponse(
    (
      <div style={baseFrame}>
        <Header />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={eyebrow}>{humanRep(op.reputationTier)} tier, score {op.reputationScore.toFixed(1)} of 100</div>
          <div style={{ ...headline, fontSize: 96, lineHeight: 1.02 }}>{op.name}</div>
          <div style={subhead}>
            {op.nodes.length} {op.nodes.length === 1 ? 'GPU node' : 'GPU nodes'}
            {gpuTiers.length > 0 ? ` (${gpuTiers.join(', ')})` : ''}
            {op.uptimePercent30d != null ? `, ${op.uptimePercent30d.toFixed(1)}% uptime` : ''}
          </div>
        </div>
        <Footer />
      </div>
    ),
    { width: 1200, height: 630 },
  )
}

const baseFrame: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  background: COLORS.bg,
  color: COLORS.ink,
  padding: '72px 80px',
  fontFamily: 'Instrument Serif, Georgia, serif',
}

const eyebrow: React.CSSProperties = {
  fontSize: 22,
  letterSpacing: 4,
  textTransform: 'uppercase',
  color: COLORS.muted,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
}

const headline: React.CSSProperties = {
  fontFamily: 'Instrument Serif, Georgia, serif',
  fontSize: 96,
  lineHeight: 1.0,
  letterSpacing: -2,
  color: COLORS.ink,
}

const subhead: React.CSSProperties = {
  fontSize: 32,
  lineHeight: 1.3,
  color: COLORS.muted,
  fontFamily: 'Instrument Serif, Georgia, serif',
  marginTop: 8,
}

function Header() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottom: `1px solid ${COLORS.hairline}`,
      paddingBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 40, color: COLORS.ink, fontFamily: 'Instrument Serif, Georgia, serif' }}>TokenOS DeAI</span>
        <span style={{ fontSize: 14, color: COLORS.muted, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>TM</span>
      </div>
      <span style={{
        fontSize: 16,
        letterSpacing: 3,
        color: COLORS.muted,
        textTransform: 'uppercase',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      }}>
        marketplace.stackforgelab.tech
      </span>
    </div>
  )
}

function Footer() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTop: `1px solid ${COLORS.hairline}`,
      paddingTop: 24,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 16,
      color: COLORS.muted,
      letterSpacing: 1,
    }}>
      <span>per-minute billing, reputation-scored operators, SSH under a minute</span>
    </div>
  )
}
