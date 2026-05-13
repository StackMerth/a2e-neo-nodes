/*
 * M5.4 / M5.6 polish: dynamic Open Graph card generator, dark mode.
 *
 * GET /og?type=home
 * GET /og?type=operator&slug=<slug>
 * GET /og?type=marketplace
 * GET /og?type=leaderboard
 *
 * Card matches the live site: deep navy background, off-white type,
 * Inter Black 900 headline, JetBrains Mono labels, two-tone
 * TokenOS_DeAI wordmark with brand green suffix. Each variant
 * carries one live metric in the bottom-right where it can be
 * fetched cheaply; on network failure we fall back to a static
 * tagline so the card never breaks.
 */
import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

export const runtime = 'edge'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

// Approximate RGB values for the dark-mode oklch tokens in globals.css.
const COLORS = {
  bg: '#14171E',
  fg: '#F8F7F2',
  muted: '#A4A8B3',
  brand: '#7DC58F',
  hairline: '#353841',
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

interface PublicStats {
  totalNodesOnline: number
  totalOperatorsOnline: number
}

interface LeaderboardRow {
  rank: number
  operatorName: string
}

interface LeaderboardResponse {
  rows: LeaderboardRow[]
}

async function fetchOperator(slug: string): Promise<OperatorPublicData | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/operators/${slug}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as OperatorPublicData
  } catch {
    return null
  }
}

async function fetchStats(): Promise<PublicStats | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/stats`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as PublicStats
  } catch {
    return null
  }
}

async function fetchTopOperator(): Promise<LeaderboardRow | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/leaderboard?tab=reputation&limit=1`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as LeaderboardResponse
    return data.rows?.[0] ?? null
  } catch {
    return null
  }
}

// Pull Inter Black + JetBrains Mono from Google Fonts at render time.
// Modern-browser User-Agent forces woff2 (Satori reads woff2 fine).
async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const familyUrl = family.replace(/ /g, '+')
    const css = await (await fetch(
      `https://fonts.googleapis.com/css2?family=${familyUrl}:wght@${weight}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
      },
    )).text()
    const match = css.match(/src: url\((.+?)\) format/)
    if (!match) return null
    return await (await fetch(match[1])).arrayBuffer()
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

  // Load fonts in parallel with whatever data fetch this variant needs.
  const [interBlack, jbMono] = await Promise.all([
    loadGoogleFont('Inter', 900),
    loadGoogleFont('JetBrains Mono', 400),
  ])

  const fonts =
    interBlack && jbMono
      ? [
          { name: 'Inter', data: interBlack, weight: 900 as const, style: 'normal' as const },
          { name: 'JBMono', data: jbMono, weight: 400 as const, style: 'normal' as const },
        ]
      : undefined

  if (type === 'operator') {
    const slug = searchParams.get('slug')
    if (!slug) return renderHome(fonts)
    const op = await fetchOperator(slug)
    if (!op) return renderHome(fonts)
    return renderOperator(op, fonts)
  }
  if (type === 'marketplace') {
    const stats = await fetchStats()
    const stat = stats?.totalNodesOnline != null
      ? `${stats.totalNodesOnline.toLocaleString()} GPUs online`
      : 'Live now'
    return renderFrame({
      eyebrow: 'Live inventory',
      headline: 'Pick a GPU.\nPay per minute.',
      stat,
      fonts,
    })
  }
  if (type === 'leaderboard') {
    const top = await fetchTopOperator()
    const stat = top?.operatorName ? `01. ${top.operatorName}` : 'Top by reputation'
    return renderFrame({
      eyebrow: 'Operator leaderboard',
      headline: 'Earned,\nnot bought.',
      stat,
      fonts,
    })
  }
  return renderHome(fonts)
}

type FontList = Array<{
  name: string
  data: ArrayBuffer
  weight: 400 | 900
  style: 'normal'
}>

function renderHome(fonts: FontList | undefined): ImageResponse {
  return renderFrame({
    eyebrow: 'The marketplace',
    headline: 'GPU compute,\nbrokered honestly.',
    stat: '<60s pay to prompt',
    fonts,
  })
}

function renderOperator(op: OperatorPublicData, fonts: FontList | undefined): ImageResponse {
  const nodeCount = op.nodes.length
  return renderFrame({
    eyebrow: `${humanRep(op.reputationTier)} tier, score ${op.reputationScore.toFixed(1)} of 100`,
    headline: op.name,
    stat: `${nodeCount} ${nodeCount === 1 ? 'GPU node' : 'GPU nodes'}`,
    fonts,
  })
}

function renderFrame({
  eyebrow,
  headline,
  stat,
  fonts,
}: {
  eyebrow: string
  headline: string
  stat: string
  fonts: FontList | undefined
}): ImageResponse {
  const headlineLines = headline.split('\n')
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          background: COLORS.bg,
          color: COLORS.fg,
          padding: '64px 80px',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            borderBottom: `1px solid ${COLORS.hairline}`,
            paddingBottom: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline' }}>
            <span style={{ fontSize: 36, fontWeight: 900, color: COLORS.fg, letterSpacing: '-0.02em' }}>
              TokenOS
            </span>
            <span style={{ fontSize: 36, fontWeight: 900, color: COLORS.brand, letterSpacing: '-0.02em' }}>
              _DeAI
            </span>
          </div>
          <span
            style={{
              fontFamily: 'JBMono, ui-monospace, monospace',
              fontSize: 16,
              color: COLORS.muted,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            marketplace.stackforgelab.tech
          </span>
        </div>

        {/* Body */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            justifyContent: 'center',
          }}
        >
          {/* Eyebrow with green hairline */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
            <span
              style={{
                display: 'block',
                width: 40,
                height: 2,
                background: COLORS.brand,
                marginRight: 16,
              }}
            />
            <span
              style={{
                fontFamily: 'JBMono, ui-monospace, monospace',
                fontSize: 18,
                color: COLORS.muted,
                letterSpacing: 4,
                textTransform: 'uppercase',
              }}
            >
              {eyebrow}
            </span>
          </div>

          {/* Headline. Satori has no native line-wrap, so each \n line
              becomes its own block. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {headlineLines.map((line, i) => (
              <span
                key={i}
                style={{
                  fontSize: 96,
                  fontWeight: 900,
                  lineHeight: 1,
                  letterSpacing: '-0.03em',
                  color: COLORS.fg,
                }}
              >
                {line}
              </span>
            ))}
          </div>
        </div>

        {/* Footer with live stat */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: `1px solid ${COLORS.hairline}`,
            paddingTop: 24,
          }}
        >
          <span
            style={{
              fontFamily: 'JBMono, ui-monospace, monospace',
              fontSize: 16,
              color: COLORS.muted,
              letterSpacing: 1,
            }}
          >
            per-minute billing, reputation-scored operators
          </span>
          <span
            style={{
              fontFamily: 'JBMono, ui-monospace, monospace',
              fontSize: 20,
              color: COLORS.brand,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            {stat}
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts,
      headers: {
        // Cache OG cards for 60s, allow CDN to serve stale for an hour
        // while a fresh one renders in the background.
        'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=3600',
      },
    },
  )
}
