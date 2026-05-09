/**
 * A2E Design Tokens
 *
 * Single source of truth for the brand visual language. Both
 * apps/dashboard and apps/portal already use most of these as
 * raw CSS variables in their globals.css files; this module
 * formalises them so:
 *
 *   1. Future code can import typed values instead of
 *      hard-coding hex strings or magic numbers.
 *   2. M4's UI build phase has a documented system to consume
 *      when it ships the shared component library.
 *   3. Design changes happen in one place.
 *
 * Companion file: ./tokens.css exports the same values as CSS
 * variables. Apps can either import the CSS at the layout level
 * or read these constants in component code (for inline styles
 * or Tailwind plugin config).
 */

/* ------------------------------------------------------------------ */
/*  Brand                                                              */
/* ------------------------------------------------------------------ */

/**
 * Primary brand color: A2E green. Used for CTAs, success states,
 * the wordmark logo, primary links, and the accent on the active
 * sidebar item.
 */
export const brand = {
  green: {
    50: '#f0fdf4',
    100: '#dcfce7',
    200: '#bbf7d0',
    300: '#86efac',
    400: '#4ade80',
    500: '#22c55e', // primary
    600: '#16a34a',
    700: '#15803d',
    800: '#166534',
    900: '#14532d',
  },
} as const

/**
 * Status / semantic colors. Used for badges, alerts, and chart
 * series. Each is an HSL-ish triplet of (light bg, mid base,
 * dark text-on-light) so a status badge can pick consistent
 * shades without re-deriving them.
 */
export const status = {
  success: { bg: 'rgba(34, 197, 94, 0.10)', base: '#22c55e', text: '#86efac' },
  warning: { bg: 'rgba(234, 179, 8, 0.10)', base: '#eab308', text: '#fde047' },
  error:   { bg: 'rgba(239, 68, 68, 0.10)', base: '#ef4444', text: '#fca5a5' },
  info:    { bg: 'rgba(59, 130, 246, 0.10)', base: '#3b82f6', text: '#93c5fd' },
  neutral: { bg: 'rgba(148, 163, 184, 0.10)', base: '#94a3b8', text: '#e2e8f0' },
} as const

/* ------------------------------------------------------------------ */
/*  Surface (dark mode primary, light mode in M4)                      */
/* ------------------------------------------------------------------ */

/**
 * Background surfaces, dark theme. Each layer is darker than the
 * previous so cards on cards stay visually distinct without
 * borders.
 */
export const surface = {
  /** Page background. Behind everything else. */
  dark: '#0a0a0f',
  /** Sidebar, modal overlay backgrounds. */
  base: '#111118',
  /** Card / glass-bg surfaces with a slight elevation. */
  card: '#16161e',
  /** Hover state for interactive cards. */
  cardHover: '#1d1d27',
  /** Glass / blurred background overlay. */
  glass: 'rgba(22, 22, 30, 0.7)',
  glassBorder: 'rgba(255, 255, 255, 0.06)',
} as const

/* ------------------------------------------------------------------ */
/*  Text                                                               */
/* ------------------------------------------------------------------ */

export const text = {
  /** Primary readable text. Headings, important data. */
  primary: '#ffffff',
  /** Body text, secondary information. */
  secondary: '#cbd5e1',
  /** Muted labels, captions, metadata. */
  muted: '#64748b',
  /** On accent backgrounds (e.g. a green button). */
  onAccent: '#0a0a0f',
} as const

/* ------------------------------------------------------------------ */
/*  Border                                                             */
/* ------------------------------------------------------------------ */

export const border = {
  /** Default subtle border (cards, inputs). */
  base: 'rgba(255, 255, 255, 0.08)',
  /** Slightly more visible (hovered, focused). */
  light: 'rgba(255, 255, 255, 0.14)',
  /** Strong, used sparingly for emphasis. */
  strong: 'rgba(255, 255, 255, 0.22)',
} as const

/* ------------------------------------------------------------------ */
/*  Spacing                                                            */
/* ------------------------------------------------------------------ */

/**
 * 4px base scale. Consistent spacing across margin, padding, gap.
 * Values map 1:1 to Tailwind's default scale (var(--space-md)
 * == p-4 == 16px) for incremental migration.
 */
export const space = {
  xs: '0.25rem', // 4px
  sm: '0.5rem',  // 8px
  md: '1rem',    // 16px
  lg: '1.5rem',  // 24px
  xl: '2rem',    // 32px
  '2xl': '3rem', // 48px
  '3xl': '4rem', // 64px
} as const

/* ------------------------------------------------------------------ */
/*  Radius                                                             */
/* ------------------------------------------------------------------ */

export const radius = {
  sm: '0.375rem', // 6px - small chips, inputs
  md: '0.5rem',   // 8px - buttons
  lg: '0.75rem',  // 12px - cards
  xl: '1rem',     // 16px - large cards, modals
  '2xl': '1.25rem', // 20px - the A2ELoader square
  full: '9999px', // pills, avatars
} as const

/* ------------------------------------------------------------------ */
/*  Typography                                                         */
/* ------------------------------------------------------------------ */

export const font = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
} as const

export const fontSize = {
  xs: '0.75rem',   // 12px - captions, metadata
  sm: '0.875rem',  // 14px - body small
  base: '1rem',    // 16px - body
  lg: '1.125rem',  // 18px - subheadings
  xl: '1.25rem',   // 20px - card titles
  '2xl': '1.5rem', // 24px - section headers
  '3xl': '1.875rem', // 30px - page titles
  '4xl': '2.25rem',  // 36px - hero numbers
} as const

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const

/* ------------------------------------------------------------------ */
/*  Shadow                                                             */
/* ------------------------------------------------------------------ */

export const shadow = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.2)',
  md: '0 4px 12px rgba(0, 0, 0, 0.3)',
  lg: '0 8px 32px rgba(0, 0, 0, 0.4)',
  /** Brand glow used on the A2ELoader and the green CTA hover. */
  brand: '0 12px 32px rgba(34, 197, 94, 0.35), 0 0 0 1px rgba(34, 197, 94, 0.2)',
} as const

/* ------------------------------------------------------------------ */
/*  Z-index                                                            */
/* ------------------------------------------------------------------ */

export const z = {
  base: 0,
  raised: 10,
  sidebar: 20,
  dropdown: 30,
  modal: 40,
  toast: 50,
  loader: 60,
} as const

/* ------------------------------------------------------------------ */
/*  Motion                                                             */
/* ------------------------------------------------------------------ */

export const motion = {
  /** Most UI transitions: 150-200ms. */
  fast: '150ms',
  /** Card hover, expanding details: 250-300ms. */
  base: '250ms',
  /** Page transitions, sidebar slide: 350-400ms. */
  slow: '350ms',
  /** Easing for most interactive transitions. */
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** Easing for state changes (active->inactive). */
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

/* ------------------------------------------------------------------ */
/*  Aggregate export                                                   */
/* ------------------------------------------------------------------ */

export const tokens = {
  brand,
  status,
  surface,
  text,
  border,
  space,
  radius,
  font,
  fontSize,
  fontWeight,
  shadow,
  z,
  motion,
} as const

export type Tokens = typeof tokens
