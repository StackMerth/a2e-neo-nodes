/**
 * C6 wave 2: PWA icon generator.
 *
 * Renders 3 PNGs from an inline SVG (solid green background + white
 * "TokenOS" wordmark) into apps/portal/public:
 *   - icon-192.png         (192x192, PWA manifest)
 *   - icon-512.png         (512x512, PWA manifest)
 *   - apple-touch-icon.png (180x180, iOS home screen)
 *
 * Run once with `pnpm --filter @a2e/portal exec tsx scripts/generate-icons.ts`.
 * Outputs are committed to the repo so production deploys never run
 * sharp. Replace with branded PNGs by dropping same-named files into
 * apps/portal/public — they take precedence over a re-run.
 */

import sharp from 'sharp'
import { mkdir } from 'fs/promises'
import { join } from 'path'

const PUBLIC_DIR = join(__dirname, '..', 'public')
const BG_COLOR = '#22c55e'

function buildSvg(size: number, fontSize: number): string {
  // Single-color background, centered white "TokenOS" wordmark. Font
  // stack falls back across platforms; sharp rasterizes via librsvg
  // which honors the first available family.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG_COLOR}" rx="${Math.round(size * 0.18)}" />
  <text
    x="50%"
    y="50%"
    dominant-baseline="middle"
    text-anchor="middle"
    fill="#ffffff"
    font-family="-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
    font-weight="700"
    font-size="${fontSize}"
    letter-spacing="-1.5"
  >TokenOS</text>
</svg>`
}

async function emit(size: number, filename: string, fontSize: number): Promise<void> {
  const svg = Buffer.from(buildSvg(size, fontSize))
  const outPath = join(PUBLIC_DIR, filename)
  await sharp(svg).png().toFile(outPath)
  // eslint-disable-next-line no-console
  console.log(`[icons] wrote ${outPath} (${size}x${size})`)
}

async function main(): Promise<void> {
  await mkdir(PUBLIC_DIR, { recursive: true })
  // Font sizes hand-tuned so "TokenOS" fills the icon without clipping.
  await emit(192, 'icon-192.png', 30)
  await emit(512, 'icon-512.png', 80)
  await emit(180, 'apple-touch-icon.png', 28)
  console.log('[icons] done. Drop a same-named PNG in public/ to override.')
}

main().catch((err) => {
  console.error('[icons] failed:', err)
  process.exit(1)
})
