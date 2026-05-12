# M5 Deliverables — Public Marketplace + Growth

Stakeholder-facing summary of what shipped in M5. Mirrors the format of
`docs/M1_DELIVERABLES.md` and `docs/M2_DELIVERABLES.md`.

**Timeline:** ~5 days focused build + ongoing verification, 2026-05-11
through 2026-05-12.
**Total commits on `main`:** 14 (M5.1 through M5.10 + polish + anti-abuse).

---

## Scope shipped

### M5.1 — Editorial design system for `apps/marketplace`
v0/shadcn "new-york" palette adopted: cream background, deep ink type,
Instrument Serif headlines, JetBrains Mono numerics, sharp 0.25rem
corners. Replaces the inherited dark/green portal theme on the public
marketplace only (other apps keep their theme until M4).

Commit: `b86b485`.

### M5.1.5 — Full landing composition port
13 section components and 3 ASCII-canvas animated background shapes
(sphere, tetrahedron, wave) ported verbatim from the design reference
repo. Hero word rotation, marquee stats, scroll-shrinking nav, mobile
overlay menu, all the editorial micro-interactions land at the right
positions.

Commit: `794416d`.

### M5.2 — Public catalog API + filterable marketplace page
`GET /v1/public/listings` aggregates idle inventory by
`(operator, gpuTier, region)`, sorted cheapest-first, filterable by
tier/region/rate/reputation. The `/marketplace` page renders a
sticky-sidebar filter form (plain GET, no client JS) and a server-
rendered listing grid with URL-synced state.

Commits: `517aef0`, `e3fa32a` (drop the YieldFloor DB pricing path in
favor of canonical `GPU_TIER_CONFIG`).

### M5.3 — Operator reputation leaderboard
`GET /v1/public/leaderboard?tab=reputation` ranks operators by
transparent score. `/leaderboard` page on the marketplace renders the
table with the rank, tier, score, completed-job volume, and node
count. Second tab "Top referrers" placeholder lands here; gets
populated by M5.7.

Commits: `e106fee`, `ca90fe5` (replace placeholder with real
ReferrersTable).

### M5.4 — SEO basics + dynamic OG cards
`robots.txt`, `sitemap.xml` (enumerates home, marketplace, leaderboard,
stats, and one entry per operator), and a dynamic `/og` route using
Next.js `ImageResponse` with four card variants. Every page declares
its own OG image and Twitter card. Operator profiles emit Schema.org
JSON-LD with Organization + AggregateRating blocks.

Commit: `b083b2c`.

### M5.5 — Swagger / OpenAPI for the public API
`@fastify/swagger` + `@fastify/swagger-ui` plugin generates a real
OpenAPI 3 spec from route schemas. Swagger UI at `/docs`, raw spec at
`/docs/json`. The three public routes (listings, leaderboard,
operators) carry query/params/response schemas with descriptions and
enums.

Commit: `c8675c0`.

### M5.7 — Operator referral program (D2)
- Schema: `NodeRunner.referralCode` (8-char base32), new `Referral`
  model with status/expiresAt/totalCommissionAccrued/lastSettledAt,
  enum `ReferralStatus` (ACTIVE/EXPIRED/REVOKED), unique constraint on
  `refereeNodeRunnerId` so an operator can only be attributed once.
- BullMQ worker (daily, env-tunable cadence) expires elapsed windows
  and accrues 10% of every referee's earnings to the referrer.
- Portal `/referral` page shows invite code, share URL, lifetime
  commission, and the list of referees with status + accrued amount.
- Public `?tab=referrers` leaderboard surfaces top earners.
- Wallet attach flow on Settings so email-first signups can paste
  their Solana payout address.
- `?ref=CODE` propagates from the marketplace share URL through the
  portal signup form to the API; banner copy makes the attribution
  visible to the new operator.
- **Anti-abuse:** signup IP captured; attribution flags sock-puppet
  pairs (same IP) as REVOKED so the worker skips them. Lifetime
  commission cap per referrer enforced in the worker
  (`REFERRAL_REFERRER_CAP_USD`, default $5000).

Commits: `91db134`, `0064b13`, `9f6984c` (recompute trigger),
`24364c0` (test-flow helper), `de238ae` (ensure slug fix), `27d4ce1`
(signup pass-through), plus the anti-abuse commit landing with M5.6.

### M5.8 — Carbon reporting (D3)
- `ComputeRequest.co2Grams` populated by the per-minute meter using a
  pure estimator in `packages/core/src/carbon-estimator.ts`.
- GPU TDP lookup table + region grid intensity lookup (US-WEST 290,
  US-EAST 380, EU 250, APAC 540, SA 140, OC 530, unknown 400).
- Active rental cards on `/buyer/active` show the live estimate.
- `/buyer/billing` shows lifetime aggregate stat block with the
  Leaf icon + green tint, plus an inline methodology footnote so the
  math is auditable.
- One-time backfill script `backfill:co2` for historical rentals.

Commits: `8d2f382`, `5c14349`.

### M5.9 — Live chat widget (D4)
Vendor-neutral client component supporting Tawk.to (recommended) or
Crisp via env vars. Portal-only; marketplace stays widget-free.
Activation parked pending new requirement from the user.

Commits: `db22bfc`, `39dcd06`.

### M5.10 — Explorer-style stats + scrapeable feeds
- `GET /v1/public/stats` — nodes online by tier, distinct operators,
  lifetime rentals, lifetime compute minutes, lifetime CO2 grams,
  region distribution, reference retail price per tier.
- `GET /v1/public/listings.json` and `.csv` — full catalog as
  scrapeable feeds with `Content-Disposition` filenames.
- `/stats` page on the marketplace renders all of the above plus a
  feeds section linking to the four scrapeable surfaces and the
  Swagger UI.

Commits: `f3470ed`, `97e484e` (Fastify response schema fix).

### M5.6 — Cross-feature QA + docs (this milestone)
- `docs/QA_MATRIX_M5.md` — 90+ row manual verification matrix
- `docs/RUNBOOK_ADMIN.md` — operations reference
- `docs/OPERATOR_GUIDE.md` — operator-side how-to
- `docs/BUYER_API.md` — buyer API reference with curl examples
- `docs/M5_DELIVERABLES.md` — this document
- OG card redesign polish pass — parked as a separate follow-up

---

## What's NOT in M5

Tracked separately, intentionally not in scope:

- **M5 polish follow-ups:** OG card redesign, chat widget activation
- **M4 work:** multi-node clusters, premium UI rollout to portal +
  dashboard, Cmd-K palette, region routing wire-up
- **Launch-blockers (Phase 2 final mile):** BYOG installer, agent
  ephemeral SSH manager, payer key encryption, mainnet wallets,
  disabling seed keep-alive, Helius Developer tier
- **Deferred M3 visual tests:** SPOT preemption banner, checkpoint
  round trip, RESERVED preemption-exempt — folded into the M5.6 QA
  matrix as runtime checks

---

## How to verify each surface

See `docs/QA_MATRIX_M5.md`. Top-level smoke test in 60 seconds:

```bash
# Public surfaces
curl -sS "https://a2e-api.onrender.com/v1/public/listings?limit=3"
curl -sS "https://a2e-api.onrender.com/v1/public/leaderboard?tab=reputation"
curl -sS "https://a2e-api.onrender.com/v1/public/stats"
curl -sS "https://a2e-api.onrender.com/v1/public/listings.csv" | head -5

# Browser
open https://marketplace.stackforgelab.tech/
open https://marketplace.stackforgelab.tech/marketplace
open https://marketplace.stackforgelab.tech/leaderboard
open https://marketplace.stackforgelab.tech/stats
open https://marketplace.stackforgelab.tech/operator/seed-bronze-runner
open https://a2e-api.onrender.com/docs

# Referral round trip
pnpm --filter @a2e/api referrals:test-flow asad@m.com
```

---

## Numbers

- **API routes added:** 6 public + 2 portal
- **Marketplace pages added:** 4 (`/marketplace`, `/leaderboard`,
  `/stats`, `/og`)
- **Workers added:** 1 (referral-commission, daily)
- **Worker extended:** 1 (per-minute meter writes CO2 grams)
- **Schema additions:** `NodeRunner.referralCode`, `NodeRunner.slug`
  index, `Referral` model, `User.signupIp`,
  `ComputeRequest.co2Grams`
- **pnpm scripts added:** `backfill:co2`, `referrals:recompute`,
  `referrals:test-flow`
- **Docs added:** 5 markdown files in `docs/`
