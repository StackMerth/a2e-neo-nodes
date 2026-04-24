/**
 * Shared color palette for compute market badges across the node-runner portal.
 *
 * Keep this in sync with the `Market` enum in `packages/database/prisma/schema.prisma`
 * so any new external market gets a consistent visual identity everywhere it appears
 * (earnings breakdowns, node cards, deployment indicators, etc.).
 */
export interface MarketColor {
  bg: string
  text: string
  bar: string
  label: string
}

export const MARKET_COLORS: Record<string, MarketColor> = {
  INTERNAL: {
    bg: 'rgba(34,197,94,0.1)',
    text: 'var(--success)',
    bar: 'var(--success)',
    label: 'Internal',
  },
  AKASH: {
    bg: 'rgba(59,130,246,0.1)',
    text: 'var(--info)',
    bar: 'var(--info)',
    label: 'Akash',
  },
  IONET: {
    bg: 'rgba(139,92,246,0.1)',
    text: '#8b5cf6',
    bar: '#8b5cf6',
    label: 'IO.net',
  },
  VASTAI: {
    bg: 'rgba(234,179,8,0.1)',
    text: '#eab308',
    bar: '#eab308',
    label: 'Vast.ai',
  },
}

const FALLBACK_COLOR: MarketColor = {
  bg: 'var(--bg-card-hover)',
  text: 'var(--text-secondary)',
  bar: 'var(--text-muted)',
  label: 'Unknown',
}

export function getMarketColor(market: string | null | undefined): MarketColor {
  if (!market) return FALLBACK_COLOR
  return MARKET_COLORS[market] ?? FALLBACK_COLOR
}
