# M2 Deliverables: Billing & Buyer Self-Serve

**Milestone:** M2 (Phase 2, billing + auto-allocator)
**Branch:** `main`
**Commits in this milestone:**

| Commit | Sub-deliverable |
|---|---|
| `447d832` | M2.1 — Prisma schema additions (Template, billing fields, eligibility flags, ephemeral SSH) |
| `e1f8d94` | M2.2 — Auto-allocator worker (B1) |
| `d23cf9c` | M2.3 — Solana payment webhook receiver |
| `24c484e` | M2.4 — Per-minute billing meter worker |
| `1c6e738` | M2.5 — Template registry routes + 7 seeded default templates |
| `18f22a7` | M2.6 — Node-agent docker image prewarm during idle |
| `97835b6` | M2.7 — Buyer terminate + prorated refund + live cost ticker |
| `3d6ac0f` | M2.8 — Admin Needs Review queue filter + release-hold action |

---

## What you can do now that you couldn't before

1. **Buyer pays. SSH details land in the dashboard with no admin click.** The auto-allocator (B1) watches for paid + on-chain-confirmed compute requests every 10s, runs eligibility rules, picks idle nodes matching the requested GPU tier, and ships back ephemeral SSH credentials. If supply isn't there, the request waits and the next tick retries automatically.

2. **Per-minute billing.** Every minute the meter writes `minutesUsed` and `accruedCost` onto each ACTIVE rental. The buyer dashboard shows a live ticker (no polling — driven by `compute:tick` websocket events). When the buyer terminates early, the prorated refund is exactly `totalCost - accruedCost`.

3. **One-click templates.** Buyers can pick from 7 pre-built environments (PyTorch+Jupyter, vLLM, ComfyUI, Whisper, Axolotl, etc.). The node-agent prewarms popular images during idle time so launches stay fast.

4. **Solana webhook.** When you point Helius at the new endpoint, payment confirmations land in ~3 seconds instead of waiting for the 30–60s polling cron. End-to-end pay-to-prompt drops from "minute or two" to "under 15 seconds".

5. **Eligibility rules with a real Needs Review queue.** First-time buyer asking for $10K of compute? It auto-holds with `HOLD_FIRST_TIME_OVER_CEILING`. Trusted buyer (3+ successful rentals) gets fast-tracked. Admin sees a "Needs Review" filter chip with a count, can hover any flag for a tooltip, and either Release Hold (back to PENDING, allocator picks up next tick) or Reject.

---

## Files added in M2

```
apps/api/src/jobs/compute-allocator.ts                  # M2.2 worker
apps/api/src/jobs/per-minute-meter.ts                   # M2.4 meter
apps/api/src/services/allocation/eligibility.ts         # M2.2 rules engine
apps/api/src/services/allocation/ssh-session.ts         # M2.2 ephemeral creds
apps/api/src/routes/webhooks-solana.ts                  # M2.3 webhook
apps/api/src/routes/templates.ts                        # M2.5 catalog routes
apps/api/scripts/seed-templates.ts                      # M2.5 seed script
apps/node-agent/src/docker/image-prewarm.ts             # M2.6 prewarm service
docs/M2_DELIVERABLES.md                                 # this file
```

## Files modified in M2

```
packages/database/prisma/schema.prisma                  # +Template, +fields
apps/api/src/index.ts                                   # wire workers + routes
apps/api/src/routes/index.ts                            # barrel exports
apps/api/src/routes/admin-compute.ts                    # release-hold + waitlisted count
apps/api/src/routes/buyer-compute.ts                    # terminate + refund
apps/api/package.json                                   # seed:templates script
apps/node-agent/src/agent.ts                            # start/stop prewarm
apps/portal/src/app/buyer/active/page.tsx               # ticker + terminate UI
apps/portal/src/lib/api.ts                              # terminateRequest helper
apps/dashboard/src/app/compute/page.tsx                 # Needs Review filter
apps/dashboard/src/lib/api.ts                           # releaseHold helper
```

---

## Tunables (env vars)

All have safe defaults; configure on Render only if you want to dial them.

| Var | Default | What it does |
|---|---|---|
| `ALLOCATOR_TICK_MS` | 10000 | How often the allocator scans for paid PENDING requests |
| `ALLOCATOR_FIRST_TIME_CEILING_USD` | 500 | First-time buyer requests above this auto-hold |
| `ALLOCATOR_TRUSTED_RENTAL_COUNT` | 3 | Successful rentals before "trusted buyer" status (skips first-time ceiling) |
| `METER_TICK_MS` | 60000 | Per-minute meter cadence |
| `SOLANA_WEBHOOK_SECRET` | (none, required) | Shared secret Helius/QuickNode must send in `x-webhook-secret` header. Endpoint refuses all requests if unset. |
| `A2E_PREWARM_INTERVAL_MS` | 1800000 | Node-agent: how often to check the prewarm list (30 min default) |
| `A2E_PREWARM_INITIAL_DELAY_MS` | 60000 | Node-agent: delay before the first prewarm cycle so registration settles |
| `A2E_PREWARM_PULL_TIMEOUT_MS` | 900000 | Node-agent: per-image pull timeout (15 min default) |

---

## What you need to verify after the next Render deploy

The next push to `main` triggers Render to redeploy `a2e-api`. Run this checklist once it's green.

### 1. Workers initialized

In the Render `a2e-api` log search for:

```
Compute allocator initialized (10s tick)
Per-minute meter initialized (60s tick)
```

If both lines appear, M2.2 + M2.4 are running.

### 2. Database schema applied

Render's startCommand still uses `prisma db push --accept-data-loss` (the migration switchover doc covers flipping that later). On boot it should silently apply all M2 additions. Quick sanity check from a Render shell:

```bash
psql "$DATABASE_URL" -c '\d "ComputeRequest"' | grep -E 'minutesUsed|accruedCost|sshSessionToken'
psql "$DATABASE_URL" -c '\d "Template"' | head -20
```

You should see all the new columns and the Template table.

### 3. Templates seeded

Run once from a Render shell so the buyer portal has something to show:

```bash
cd /opt/render/project/src/apps/api
DATABASE_URL="$DATABASE_URL" npx tsx scripts/seed-templates.ts
```

Expected output:
```
Seeding 7 templates...
  created  pytorch-cuda12-jupyter
  created  tensorflow-cuda12-jupyter
  ...
Done.
```

The script is idempotent — safe to run again.

### 4. Public templates endpoint live

```bash
curl https://api.tokenos.ai/v1/templates | jq '.templates[].slug'
```

Should list all 7 slugs.

### 5. Smoke-test the auto-allocator on staging

End-to-end (uses the dev-mode payment path so no real money moves):

1. Sign up a fresh buyer account: `buyer@tokenos.ai`
2. Submit a compute request from the portal — small one, $50 worth, well under the eligibility ceiling
3. Pay with the dev-mode txHash (UI auto-fills it in dev mode)
4. Watch the request:
   - Status flips PENDING → ALLOCATED within 10–15 seconds
   - SSH details appear in the dashboard
   - The buyer's `/buyer/active` page shows the new card with a `$0.00 / $50.00` ticker that ticks up every minute

If allocation doesn't happen, check the API logs for `[compute-allocator]` lines — most likely cause is no idle nodes matching the requested tier.

### 6. Smoke-test the eligibility hold

Same flow but request 16x H100s for 30 days from a fresh buyer (totalCost ≈ $67K, way over the $500 ceiling):

1. Submit and pay
2. Status should land in `WAITLISTED` within 10–15s
3. Open admin dashboard → Compute → click the **"Needs Review"** filter chip
4. The request should be listed with a flag count chip (hover to see `HOLD_FIRST_TIME_OVER_CEILING`)
5. Click **Release Hold** → status flips back to PENDING → allocator picks it up next tick

### 7. Smoke-test early termination + refund

1. With an ACTIVE rental on the dev-mode test buyer, click **Terminate Early** on the buyer portal
2. Confirm the dialog (it shows live accrued + estimated refund)
3. Status flips to COMPLETED, the card disappears
4. API response includes `refundStatus: 'SENT'` and `refundTxHash: 'DEV_xxx'`
5. (Live mode test waits until you flip Solana to live — see deferred items below)

### 8. Smoke-test the Solana webhook

After you configure Helius (next section):

1. Submit a compute request that requires payment confirmation
2. Pay on Solana devnet with a real (small) transaction
3. Watch API logs for:
   ```
   Webhook confirmed payment {sig: '...', computeResult: 1}
   ```
4. Time from "tx finalizes on-chain" to "txConfirmed=true on the row" should be ≈3s
5. Allocator picks it up next tick → end-to-end ≈10-15s

---

## What you need to manually configure

### Required for M2 to be usable

#### A. Render env vars on `a2e-api`

Add these in Render → a2e-api → Environment:

| Key | Value | Why |
|---|---|---|
| `SOLANA_WEBHOOK_SECRET` | a random 32+ char string (e.g. `openssl rand -hex 32` output) | Helius webhook auth header. Endpoint refuses all requests if unset. |

The other M2 env vars are optional — keep defaults unless you want to tune.

#### B. Helius webhook console (5 minutes)

1. https://www.helius.dev → sign in (or create account, free tier is fine for now)
2. **API Keys** → create one, copy the value (you'll need it for the URL)
3. **Webhooks** → Create Webhook
   - Webhook URL: `https://api.tokenos.ai/v1/webhooks/solana`
   - Webhook Type: `Enhanced`
   - Transaction Type: `Any` (or filter to `TRANSFER` if you want only token movements)
   - Account Addresses: paste the merchant wallet that receives buyer payments (the same address buyers send USDC to)
   - Auth Header: `x-webhook-secret: <the same value as SOLANA_WEBHOOK_SECRET on Render>`
   - Network: Mainnet for production; Devnet for staging
4. Save. Helius will start pushing tx confirmations within a few minutes of any matching transaction.

#### C. Seed the template catalog

One-time on the live DB (see Verification §3 above):

```bash
DATABASE_URL="$DATABASE_URL" npx tsx scripts/seed-templates.ts
```

Idempotent — safe to re-run if you ever change the template list in the script.

### Optional but recommended

#### D. Tune the eligibility ceilings

If $500 first-time ceiling is wrong for your buyer base, set on Render:

```
ALLOCATOR_FIRST_TIME_CEILING_USD=200    # tighter
ALLOCATOR_TRUSTED_RENTAL_COUNT=5        # require more history before fast-track
```

#### E. Buyer wallet field

Refunds only ship if the buyer has `walletAddress` set on their User row. The portal `Settings` page lets buyers add it. For M2 you might want to add a one-line nudge to the buyer dashboard ("Add a payout wallet so refunds can be sent") if `user.walletAddress` is null. Not blocking — refund route handles missing wallet by setting `refundStatus: 'SKIPPED_NO_WALLET'` and notifying the buyer.

---

## Known dependencies on previously-deferred M1 items

Two M2 features are dev-mode-only until you complete the deferred M1 follow-ups:

1. **Live Solana refunds** require flipping `PAYMENT_MODE=live` and funding a real payer wallet. Right now dev mode returns `DEV_xxx` tx hashes (no real money moves). Before flipping to live, ship the **payer-key-out-of-DB** fix (M1 item #7, deferred). The current fields in `SettlementConfig.payerPrivateKey` are plaintext.

2. **Test Mode bug retest** (M1 item #4, deferred). Now that Sentry is wired, the next time you test the deployment Test Mode flow you'll get a real stack trace if it fails. M2 doesn't depend on Test Mode but the next milestone (M3 reputation tiers) needs end-to-end deployment of new node runners working.

3. **Public status page** (M1 item #9, deferred). Better Stack URL pending. Not a blocker for M2, but once you have the URL the 10-line dashboard footer link is a quick follow-up.

---

## What's NOT in M2 (planned for later milestones)

- **M3 (Operator Trust & Tiers):** reputation scoring, spot/reserved pricing, checkpoint API, vanity operator profiles
- **M4 (Multi-Node Clusters & UI):** atomic multi-node clusters with WireGuard mesh, premium UI shipped to all 3 frontends
- **M5 (Public Marketplace & Polish):** public marketplace at `marketplace.tokenos.ai`, OG share cards, OpenAPI docs, full QA matrix
