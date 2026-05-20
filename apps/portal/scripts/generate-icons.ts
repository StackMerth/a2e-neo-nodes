/**
 * C6 wave 2: PWA icon generator.
 *
 * Renders 3 PNGs from an inline SVG matching the marketing wordmark:
 * dark canvas, "TokenOS" in white + "_DeAI" in brand green. Outputs
 * land in apps/portal/public:
 *   - icon-192.png         (192x192, PWA manifest)
 *   - icon-512.png         (512x512, PWA manifest)
 *   - apple-touch-icon.png (180x180, iOS home screen)
 *
 * Run with `pnpm --filter @a2e/portal exec tsx scripts/generate-icons.ts`.
 * Outputs are committed to the repo so production deploys never run
 * sharp. Replace with hand-designed PNGs by dropping same-named files
 * into apps/portal/public — they take precedence over a re-run.
 */

import sharp from 'sharp'
import { mkdir } from 'fs/promises'
import { join } from 'path'

const PUBLIC_DIR = join(__dirname, '..', 'public')
const BG_COLOR = '#0a0a0f' // matches --bg-dark in the portal theme
const TEXT_COLOR = '#ffffff'
const ACCENT_COLOR = '#22c55e' // brand green used on _DeAI suffix

function buildSvg(size: number, fontSize: number): string {
  // Two-tone wordmark via <tspan>. Letter-spacing slightly tightened so
  // the full 12-char string reads as one block instead of a row of
  // separate glyphs. Background is the portal's dark canvas color so
  // the icon matches the brand wherever it shows up (PWA install
  // shelf, iOS home screen, Android launcher).
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG_COLOR}" rx="${Math.round(size * 0.18)}" />
  <text
    x="50%"
    y="50%"
    dominant-baseline="middle"
    text-anchor="middle"
    font-family="-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
    font-weight="800"
    font-size="${fontSize}"
    letter-spacing="-1"
  ><tspan fill="${TEXT_COLOR}">TokenOS</tspan><tspan fill="${ACCENT_COLOR}">_DeAI</tspan></text>
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
  // Font sizes hand-tuned so "TokenOS_DeAI" fills ~80% of the icon
  // width across all three target dimensions without clipping. The
  // 12-character wordmark is wider than the previous 7-character one,
  // so the font is a touch smaller relative to canvas.
  await emit(192, 'icon-192.png', 22)
  await emit(512, 'icon-512.png', 58)
  await emit(180, 'apple-touch-icon.png', 20)
  console.log('[icons] done. Drop a same-named PNG in public/ to override.')
}

main().catch((err) => {
  console.error('[icons] failed:', err)
  process.exit(1)
})
