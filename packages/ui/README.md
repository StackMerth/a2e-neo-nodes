# @a2e/ui

Shared design system for A2E platform apps.

## Status

**M1 (current):** design tokens only. This package exports a typed
TypeScript module and a CSS variables file that codify the brand
visual language used by `apps/dashboard` and `apps/portal`.

**M4 (planned):** component primitives. Button, Card, Table, Modal,
Sidebar, CommandPalette, StatusDot, and the rest of the shared UI
will move here so the three frontend apps consume one source of
truth instead of each maintaining its own copies.

## What's in here

```
packages/ui/
├── src/
│   ├── tokens.ts       # TypeScript design tokens
│   ├── tokens.css      # Same values as CSS variables
│   └── index.ts        # Barrel export
├── package.json
├── tsconfig.json
└── README.md
```

## How to use

### From a TypeScript file

```ts
import { tokens, brand, surface } from '@a2e/ui'

const buttonStyle = {
  background: brand.green[500],
  color: surface.dark,
  borderRadius: tokens.radius.md,
}
```

### From a CSS file

Add this once at the top of `globals.css`:

```css
@import '@a2e/ui/tokens.css';

/* now you can use --a2e-* variables anywhere */
.my-card {
  background: var(--a2e-glass-bg);
  border: 1px solid var(--a2e-glass-border);
  padding: var(--a2e-space-lg);
  border-radius: var(--a2e-radius-lg);
}
```

## Token categories

| Category | What it covers | Example |
|---|---|---|
| `brand` | A2E green scale (50-900) | `--a2e-green-500` |
| `status` | Semantic colors (success/warning/error/info) | `--a2e-error` |
| `surface` | Background layers for the dark theme | `--a2e-bg-card` |
| `text` | Typography colors | `--a2e-text-primary` |
| `border` | Border opacity tiers | `--a2e-border` |
| `space` | 4px-base spacing scale | `--a2e-space-md` |
| `radius` | Corner rounding | `--a2e-radius-lg` |
| `font` | Font family stacks | `--a2e-font-sans` |
| `fontSize` | Type scale | `--a2e-text-2xl` |
| `shadow` | Drop shadows + brand glow | `--a2e-shadow-brand` |
| `z` | Stacking layer indices | `--a2e-z-modal` |
| `motion` | Transition durations + easings | `--a2e-motion-base` |

## Migration plan from existing app CSS

The existing `apps/dashboard/src/globals.css` and
`apps/portal/src/globals.css` define their own CSS variables with
slightly different names (e.g. `--bg-card`, `--text-primary`). M4
will:

1. Replace the per-app variable definitions with `@import '@a2e/ui/tokens.css'`.
2. Map any legacy variable names to the new `--a2e-*` form via aliases.
3. Refactor inline styles to use the typed `tokens` import.

For M1, both apps continue to use their own CSS variables. The
`@a2e/ui` package exists as the canonical reference and the
foundation that M4 builds on.

## Color philosophy

Dark theme is primary. Light mode is M4 work. The dark palette is
designed around:

- A near-black page background (`#0a0a0f`) so the brand green pops
  without feeling neon.
- Three surface tiers (`bg-base` → `bg-card` → `bg-card-hover`) so
  cards on cards stay distinguishable without visible borders.
- A glass overlay (`glass-bg` + 6% white border) for elevated
  surfaces like modals and command palettes.

## Spacing philosophy

4px base scale, mapped to Tailwind's default scale (var(--a2e-space-md)
= 16px = `p-4`). This means component code can incrementally migrate
from arbitrary Tailwind values to design tokens without changing
visual output.

## Adding a new token

Three rules of thumb before adding to this file:

1. **Re-used at least 3 places**. One-off values stay inline.
2. **Has a name that describes intent, not appearance**. `--a2e-error`,
   not `--a2e-red-400`. Intent stays stable; appearance can change.
3. **Cross-referenced in TS and CSS**. Both surfaces stay in sync.

If you want to add a new token, edit BOTH `src/tokens.ts` and
`src/tokens.css` in the same commit.
