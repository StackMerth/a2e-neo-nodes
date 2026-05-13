/*
 * M5.4 / M5.6 polish: dynamic Open Graph card generator, dark mode.
 *
 * GET /og?type=home
 * GET /og?type=operator&slug=<slug>
 * GET /og?type=marketplace
 * GET /og?type=leaderboard
 *
 * Card matches the live site: deep navy, off-white, brand green
 * accent, two-tone TokenOS_DeAI wordmark. Each variant carries one
 * live metric in the bottom-right where the API supports it; on
 * network failure we fall back to a static tagline so the card
 * never breaks. Fonts default to Satori's built-in fallback to
 * keep the rendering path cheap and reliable; we can swap in a
 * custom Inter binary later if the default feels off.
 */
import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

export const runtime = 'edge'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

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
  reputationScore: number
  reputationTier: ReputationTier
  nodes: Array<{ gpuTier: string }>
}

interface PublicStats {
  totalNodesOnline: number
}

interface LeaderboardRow {
  rank: number
  operatorName: string
}

async function safeFetch<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
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
    if (!slug) return renderHome()
    const op = await safeFetch<OperatorPublicData>(`${API_URL}/v1/public/operators/${slug}`)
    if (!op) return renderHome()
    const nodeCount = op.nodes.length
    return renderFrame({
      eyebrow: `${humanRep(op.reputationTier)} tier, score ${op.reputationScore.toFixed(1)} of 100`,
      headlineL1: op.name,
      stat: `${nodeCount} ${nodeCount === 1 ? 'GPU node' : 'GPU nodes'}`,
    })
  }

  if (type === 'marketplace') {
    const stats = await safeFetch<PublicStats>(`${API_URL}/v1/public/stats`)
    const stat = stats?.totalNodesOnline != null
      ? `${stats.totalNodesOnline.toLocaleString()} GPUs online`
      : 'Live now'
    return renderFrame({
      eyebrow: 'Live inventory',
      headlineL1: 'Pick a GPU.',
      headlineL2: 'Pay per minute.',
      stat,
    })
  }

  if (type === 'leaderboard') {
    const data = await safeFetch<{ rows: LeaderboardRow[] }>(
      `${API_URL}/v1/public/leaderboard?tab=reputation&limit=1`,
    )
    const top = data?.rows?.[0]
    const stat = top?.operatorName ? `01. ${top.operatorName}` : 'Top by reputation'
    return renderFrame({
      eyebrow: 'Operator leaderboard',
      headlineL1: 'Earned,',
      headlineL2: 'not bought.',
      stat,
    })
  }

  return renderHome()
}

function renderHome(): ImageResponse {
  return renderFrame({
    eyebrow: 'The marketplace',
    headlineL1: 'GPU compute,',
    headlineL2: 'brokered honestly.',
    stat: '<60s pay to prompt',
  })
}

function renderFrame({
  eyebrow,
  headlineL1,
  headlineL2,
  stat,
}: {
  eyebrow: string
  headlineL1: string
  headlineL2?: string
  stat: string
}): ImageResponse {
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
            <span style={{ fontSize: 36, fontWeight: 800, color: COLORS.fg }}>TokenOS</span>
            <span style={{ fontSize: 36, fontWeight: 800, color: COLORS.brand }}>_DeAI</span>
          </div>
          <span
            style={{
              fontSize: 16,
              color: COLORS.muted,
              letterSpacing: 2,
              textTransform: 'uppercase',
            }}
          >
            market.tokenos.ai
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
            <div
              style={{
                display: 'flex',
                width: 40,
                height: 2,
                background: COLORS.brand,
                marginRight: 16,
              }}
            />
            <span
              style={{
                fontSize: 18,
                color: COLORS.muted,
                letterSpacing: 4,
                textTransform: 'uppercase',
              }}
            >
              {eyebrow}
            </span>
          </div>

          {/* Headline. Two lines render as separate blocks so Satori
              respects line break without wrapping logic. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span
              style={{
                fontSize: 96,
                fontWeight: 900,
                lineHeight: 1,
                color: COLORS.fg,
              }}
            >
              {headlineL1}
            </span>
            {headlineL2 && (
              <span
                style={{
                  fontSize: 96,
                  fontWeight: 900,
                  lineHeight: 1,
                  color: COLORS.fg,
                }}
              >
                {headlineL2}
              </span>
            )}
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
              fontSize: 16,
              color: COLORS.muted,
              letterSpacing: 1,
            }}
          >
            per-minute billing, reputation-scored operators
          </span>
          <span
            style={{
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
    },
  )
}
