# M5 Cross-Feature QA Matrix

Manual verification sweep for every public surface and worker added in M5,
plus the three M3 visual tests that were deferred during the M5 push.

**How to use:** walk the rows top-to-bottom. Each row is a single concrete
check with a pass/fail criterion. Mark `[x]` when verified. Issues found go
to the `Issues` table at the bottom with severity (P0 blocks launch, P1
must-fix-soon, P2 nice-to-have).

**Environments:**
- Marketplace: `https://marketplace.stackforgelab.tech`
- Portal: `https://a2e-user.stackforgelab.tech`
- API: `https://tokenosdeai-api.onrender.com`

---

## 1. Public marketplace catalog (M5.2)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 1.1 | `/marketplace` loads in < 1.5 s SSR | Page renders with cream background, listings visible, no flicker | [ ] |
| 1.2 | Filter by `gpuTier=H100` | Only H100 rows shown, URL has `?gpuTier=H100`, listing count drops accordingly | [ ] |
| 1.3 | Filter by `region=US-EAST` | Only us-east-1 listings shown | [ ] |
| 1.4 | Filter `tier=SPOT` | All prices show 60% of ON_DEMAND value, label reads "Spot (40% off)" | [ ] |
| 1.5 | Filter `minReputation=GOLD` | Only GOLD+ operators visible (currently empty against seed data) | [ ] |
| 1.6 | Share filtered URL in new private browser | Same filtered view reproduces | [ ] |
| 1.7 | Click an operator card | Routes to `/operator/<slug>` correctly | [ ] |
| 1.8 | Clear all filters | URL strips params, all listings return | [ ] |
| 1.9 | API direct: `curl /v1/public/listings?limit=5` | Returns 14 total, listings array shaped correctly, sorted cheapest first | [ ] |

## 2. Leaderboard (M5.3 + M5.7)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 2.1 | `/leaderboard` default tab | Shows reputation table with seed-bronze-runner #1, seed-gold-runner #2 | [ ] |
| 2.2 | Click "Top referrers" tab | Switches view, URL has `?tab=referrers` | [ ] |
| 2.3 | Empty referrers state | If no Referral rows: "No referrers yet." with notice subhead | [ ] |
| 2.4 | After `referrals:test-flow` runs | Asad appears at rank 1, lifetime commission $10.00, 1 referee | [ ] |
| 2.5 | Click a referrer row | Routes to operator profile correctly | [ ] |
| 2.6 | API direct: `curl /v1/public/leaderboard?tab=reputation` | Returns rows array with rank, slug, tier, score, totalCompletedJobs, totalNodes | [ ] |
| 2.7 | API direct: `curl /v1/public/leaderboard?tab=referrers` | Returns rows sorted by lifetimeCommission desc | [ ] |

## 3. Operator vanity profile (M3.8 + M5.4 SEO)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 3.1 | `/operator/seed-bronze-runner` loads | Operator name, reputation tier word, score, uptime, GPU inventory, recent ratings | [ ] |
| 3.2 | JSON-LD present in source | View source contains `<script type="application/ld+json">` with Organization + AggregateRating | [ ] |
| 3.3 | OG meta tags | View source contains `<meta property="og:image" content="...og?type=operator&slug=..."/>` | [ ] |
| 3.4 | OG image renders | Hit `/og?type=operator&slug=seed-bronze-runner` directly: 1200x630 PNG with operator name in serif | [ ] |
| 3.5 | Slug-less operator | Returns 404 cleanly, no 500 | [ ] |

## 4. SEO basics (M5.4)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 4.1 | `/robots.txt` | Returns `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ...` | [ ] |
| 4.2 | `/sitemap.xml` | Includes /, /marketplace, /leaderboard, /stats, plus one entry per operator slug | [ ] |
| 4.3 | `/og?type=home` | 1200x630 PNG: cream bg, Instrument Serif "GPU compute, brokered honestly." | [ ] |
| 4.4 | `/og?type=marketplace` | 1200x630 PNG: "GPU inventory, live." | [ ] |
| 4.5 | `/og?type=leaderboard` | 1200x630 PNG: "Earned, not bought." | [ ] |
| 4.6 | Twitter card validator | Paste any URL into <https://cards-dev.twitter.com/validator>, OG image renders | [ ] |
| 4.7 | Schema.org validator | Paste an operator URL into <https://validator.schema.org/>, Organization + AggregateRating validate | [ ] |

## 5. OpenAPI / Swagger UI (M5.5)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 5.1 | `api...onrender.com/docs` | Swagger UI loads with title "TokenOS DeAI Marketplace API" | [ ] |
| 5.2 | "Public" tag has 5 routes | listings, listings.json, listings.csv, leaderboard, operators/:slug, stats | [ ] |
| 5.3 | "Try it out" on `/v1/public/listings` | Click Execute with default params, returns 200 with body | [ ] |
| 5.4 | Spec at `/docs/json` | Returns valid OpenAPI 3 document, paths object has all six public routes | [ ] |
| 5.5 | bearerAuth scheme | Spec components.securitySchemes.bearerAuth = http/bearer/JWT | [ ] |

## 6. Referral program (M5.7 + polish)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 6.1 | Portal sidebar | "Referrals" entry with Users icon between Jobs and Settings | [ ] |
| 6.2 | `/referral` for fresh signup | Auto-creates NodeRunner + slug + referralCode; page renders | [ ] |
| 6.3 | Copy invite code | "Copy" button on the 8-char code shows check, clipboard verified | [ ] |
| 6.4 | Copy share URL | Format: `https://marketplace.stackforgelab.tech/?ref=<CODE>` | [ ] |
| 6.5 | Empty referrals state | "No referrals yet" copy explains BYOG flow | [ ] |
| 6.6 | Settings wallet attach (email signup with no wallet) | Card visible, paste a Solana address, save | [ ] |
| 6.7 | Wallet save validation | 31-char input rejected as "Invalid Solana wallet address" | [ ] |
| 6.8 | Wallet conflict | Reusing another account's wallet returns 409 toast | [ ] |
| 6.9 | Share URL flow (marketplace side) | Open `/?ref=ABCDEFGH` in private browser, inspect any portal-signup link href: should contain `?ref=ABCDEFGH` | [ ] |
| 6.10 | Marketplace `/signup` banner | "Invited by ABCDEFGH" appears | [ ] |
| 6.11 | `/register` banner | Same banner after picking Node Runner | [ ] |
| 6.12 | Buyer signup with `?ref=` | Banner says program is operator-only, signup succeeds, no Referral row created | [ ] |
| 6.13 | `referrals:test-flow` script | Pasting output shows referrer, referee, commission=$10.00 (10% of $100) | [ ] |
| 6.14 | `referrals:recompute` script | Re-running prints before/after totals matching delta | [ ] |
| 6.15 | Sock-puppet detection | Sign up referrer + referee from same IP, attribution returns SOCK_PUPPET_FLAGGED, Referral row has status=REVOKED | [ ] |
| 6.16 | Commission cap enforcement | Set `REFERRAL_REFERRER_CAP_USD=10`, run test-flow, verify ticked accrual stops at $10 | [ ] |

## 7. Carbon reporting (M5.8)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 7.1 | Active rental card shows CO2 | After meter tick (60s into a rental), card shows "Carbon emitted (estimate): N g CO2" | [ ] |
| 7.2 | Billing page lifetime CO2 | `/buyer/billing` shows fourth stat block "CO2 emitted (est.)" with Leaf icon, green tint | [ ] |
| 7.3 | CO2 math sanity | 1 H100 / 60 min / us-east-1 should be ~266 g (700W * 60min/60 / 1000 * 380 g/kWh) | [ ] |
| 7.4 | Backfill script | `pnpm --filter @a2e/api backfill:co2` populates historical rentals; billing page total ticks up | [ ] |
| 7.5 | Methodology footnote | Billing page shows the formula + lookup tables inline | [ ] |

## 8. Live chat widget (M5.9)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 8.1 | Env vars unset | No widget renders on portal, no console errors | [ ] |
| 8.2 | Tawk env vars set | Bubble appears bottom-right after ~1-2 s | [ ] |
| 8.3 | Click bubble | Chat panel opens with vendor branding | [ ] |
| 8.4 | Send test message | Lands in vendor inbox | [ ] |
| 8.5 | Marketplace pages | No widget on `/`, `/marketplace`, `/leaderboard`, `/stats`, `/operator/<slug>` | [ ] |

## 9. Explorer / network stats (M5.10)

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 9.1 | `/stats` loads | Four big counters render with real seed numbers | [ ] |
| 9.2 | Tier breakdown | Shows H100/H200/B200/B300/GB300 counts | [ ] |
| 9.3 | Regional spread bars | Bar grid renders, proportions match counts | [ ] |
| 9.4 | Retail price table | 5 cards with correct $/hr and $/min for each tier | [ ] |
| 9.5 | Lifetime CO2 line | Visible only after backfill script run | [ ] |
| 9.6 | `/v1/public/stats` | Returns rich JSON with all expected fields | [ ] |
| 9.7 | `/v1/public/listings.json` | Returns Content-Disposition file, valid JSON with `generatedAt`, `count`, `listings[]` | [ ] |
| 9.8 | `/v1/public/listings.csv` | First line is header, body rows are well-formed CSV with comma quoting on operator names | [ ] |

## 10. Deferred M3 visual verifications

These were planned during M3 but visual UI verification was deferred to this matrix.

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 10.T5 | SPOT preemption banner | Follow `Test 5 (SPOT preemption) — visual UI verification` plan from the plan file; rent a SPOT H100, submit ON_DEMAND while all other H100s paused, banner appears with 90s countdown | [ ] |
| 10.T5b | SPOT preemption bell | Notification "SPOT Preemption Notice" lands in the bell with refund amount | [ ] |
| 10.T6 | Checkpoint round trip | (BLOCKED on Project 2 ephemeral SSH) Mid-rental click Checkpoint, terminate, re-rent with restoreCheckpointId, verify a sentinel file from previous workspace exists | [ ] |
| 10.T7 | RESERVED tier preemption-exempt | Rent a RESERVED H100, force a preemption scenario, verify the RESERVED rental is NOT in the spot-preemption Phase 2 candidate list (log line should be missing) | [ ] |

## 11. Cross-app cohesion

| # | Check | Pass criterion | Status |
|---|---|---|---|
| 11.1 | Marketplace nav | Marketplace, Leaderboard, Stats, Pricing visible; clicking each navigates correctly | [ ] |
| 11.2 | Marketplace mobile menu | Hamburger opens full-screen overlay, staggered link animation, all anchors work | [ ] |
| 11.3 | Portal sidebar | Dashboard / Deploy / Nodes / Deployments / Earnings / Payouts / Withdrawals / Jobs / Referrals / Settings | [ ] |
| 11.4 | Portal login → referral page | Sign in, click Referrals, see invite code | [ ] |
| 11.5 | Portal logout | Logging out from /referral redirects to /login, no leaked auth state | [ ] |

---

## Issues found

| ID | Severity | Description | Status |
|---|---|---|---|
| | | | |

(Add rows during the sweep.)

## Sign-off

- **Run by:**
- **Date:**
- **Environment commit:**
- **Total checks:** N/M passing
- **P0 issues:** 0
- **Decision:** Ship / Hold
