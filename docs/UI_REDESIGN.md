# A²E Dashboard UI Redesign

> **Branch:** `feature/ui-redesign`
> **Baseline commit:** `1f4b7fd` (on main)
> **To revert:** `git checkout main` or `git revert`

---

## Design System Overview

This document defines the reusable UI system for the A²E dashboard. All components and styles should be **global and reusable** across pages.

---

## Color Palette

### Primary Colors
```css
--background: #0a0a0a;          /* Page background */
--surface: #111111;             /* Card background */
--surface-hover: #1a1a1a;       /* Hover state */
--surface-elevated: #161616;    /* Elevated cards */
--border: #222222;              /* Default border */
--border-subtle: #1a1a1a;       /* Subtle borders */
```

### Accent Colors
```css
--accent: #22c55e;              /* Primary green */
--accent-hover: #16a34a;        /* Green hover */
--accent-glow: rgba(34, 197, 94, 0.15);  /* Glow effect */

--blue: #3b82f6;                /* Secondary blue */
--blue-glow: rgba(59, 130, 246, 0.15);

--purple: #8b5cf6;              /* Tertiary purple */
--purple-glow: rgba(139, 92, 246, 0.15);
```

### Gradients
```css
--gradient-accent: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
--gradient-blue: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
--gradient-purple: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
--gradient-mixed: linear-gradient(135deg, #22c55e 0%, #3b82f6 50%, #8b5cf6 100%);
--gradient-surface: linear-gradient(180deg, #161616 0%, #111111 100%);
```

### Status Colors
```css
--success: #22c55e;
--warning: #f59e0b;
--error: #ef4444;
--info: #3b82f6;
```

---

## Component Architecture

### 1. Global CSS Classes (globals.css)

All reusable animations, effects, and utilities go here.

### 2. UI Components (components/ui/)

| Component | Purpose |
|-----------|---------|
| `Card.tsx` | Base card with variants (default, glass, gradient-border) |
| `StatCard.tsx` | Stats display with counter animation and icons |
| `Button.tsx` | Buttons with gradient and glow variants |
| `ProgressBar.tsx` | Animated gradient progress bars |
| `Badge.tsx` | Status badges with glow effects |
| `Skeleton.tsx` | Loading skeleton components |
| `Icon.tsx` | Icon wrapper with consistent sizing |

### 3. Layout Components (components/layout/)

| Component | Purpose |
|-----------|---------|
| `Header.tsx` | Top navigation with gradient border |
| `PageHeader.tsx` | Page titles with breadcrumbs |
| `Section.tsx` | Content sections with dividers |
| `Grid.tsx` | Responsive grid layouts |

### 4. Dashboard Components (components/dashboard/)

| Component | Purpose |
|-----------|---------|
| `ActivityFeed.tsx` | Real-time activity list |
| `SystemHealth.tsx` | Service status indicators |
| `EarningsChart.tsx` | Earnings visualization |
| `MetricCard.tsx` | Large metric displays |

---

## Animation System

### Durations
```css
--duration-fast: 150ms;
--duration-normal: 300ms;
--duration-slow: 500ms;
```

### Easing
```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
```

### Common Animations
- `fadeIn` - Opacity 0 to 1
- `slideUp` - Translate Y with fade
- `scaleIn` - Scale from 0.95 to 1
- `countUp` - Number counter animation
- `shimmer` - Loading skeleton effect
- `pulse` - Gentle pulse for live indicators
- `glow` - Pulsing glow effect

---

## Implementation Tasks

### Phase 1: Foundation (Global Styles)
- [ ] Update `globals.css` with CSS variables
- [ ] Add animation keyframes
- [ ] Add utility classes
- [ ] Update `tailwind.config.js` with extended theme

### Phase 2: Core Components
- [ ] Redesign `Card.tsx` with glass variant
- [ ] Create `StatCard.tsx` with animations
- [ ] Create `ProgressBar.tsx` component
- [ ] Create `Badge.tsx` component
- [ ] Create `Skeleton.tsx` component
- [ ] Update `Button.tsx` with gradients

### Phase 3: Layout Components
- [ ] Update `Header.tsx` with gradient border
- [ ] Create `PageHeader.tsx` component
- [ ] Create `Section.tsx` component

### Phase 4: Overview Page
- [ ] Redesign hero section
- [ ] Implement animated stat cards
- [ ] Redesign distribution cards
- [ ] Update earnings chart styling
- [ ] Improve system health display
- [ ] Update activity feed
- [ ] Add skeleton loaders

### Phase 5: Testing & Polish
- [ ] Test responsive layouts
- [ ] Verify animations performance
- [ ] Cross-browser testing
- [ ] Deploy and verify

---

## File Structure

```
apps/dashboard/src/
├── globals.css                    # Global styles & animations
├── components/
│   ├── ui/
│   │   ├── Card.tsx              # Base card component
│   │   ├── StatCard.tsx          # Stats with animations
│   │   ├── Button.tsx            # Button variants
│   │   ├── ProgressBar.tsx       # Animated progress
│   │   ├── Badge.tsx             # Status badges
│   │   └── Skeleton.tsx          # Loading skeletons
│   ├── layout/
│   │   ├── Header.tsx            # Top navigation
│   │   ├── PageHeader.tsx        # Page title + breadcrumbs
│   │   └── Section.tsx           # Content sections
│   └── dashboard/
│       ├── ActivityFeed.tsx
│       ├── SystemHealth.tsx
│       └── EarningsChart.tsx
└── app/
    ├── page.tsx                  # Overview (template)
    ├── nodes/
    ├── jobs/
    ├── routing/
    ├── rates/
    ├── financial/
    └── settings/
```

---

## Rollback Instructions

If the redesign needs to be reverted:

```bash
# Option 1: Switch back to main branch
git checkout main

# Option 2: Revert specific commits
git revert <commit-hash>

# Option 3: Reset to baseline
git reset --hard 1f4b7fd
```

---

## Notes for Other Pages

Once the Overview page is complete, apply the same patterns to:

1. **Nodes Page** - Use StatCard for node counts, ProgressBar for utilization
2. **Jobs Page** - Use Badge for status, Card variants for job details
3. **Routing Page** - Use glass cards for routing form
4. **Rates Page** - Use gradient progress bars for rate comparisons
5. **Financial Page** - Use StatCard for metrics, charts for trends
6. **Settings Page** - Use Section component for grouping

Each page should import from the shared component library, not define its own styles.
