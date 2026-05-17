# TokenOS DeAI Admin Runbook

Operational reference for whoever is on-call for the TokenOS DeAI platform.
Assumes Render (API + Postgres + Redis), Vercel (marketplace, portal,
dashboard), and Solana devnet/mainnet for payments.

---

## 1. Where things live

| Surface | Provider | URL | Notes |
|---|---|---|---|
| API | Render | <https://tokenosdeai-api.onrender.com> | Fastify + BullMQ workers; exposes `/v1/public/*` and `/v1/portal/*` + Swagger at `/docs` |
| Postgres | Render | (internal) | Schema lives in `packages/database/prisma/schema.prisma` |
| Redis | Render | (internal) | BullMQ queues + cached aggregates |
| Marketplace | Vercel | <https://marketplace.stackforgelab.tech> | Public site, no auth |
| Portal | Vercel | <https://a2e-user.stackforgelab.tech> | Buyers + operators |
| Dashboard (admin) | Vercel | <https://a2e-admin.stackforgelab.tech> | Admin role only |
| Repo | GitHub | <https://github.com/StackMerth/a2e-neo-nodes> | `main` is production |

## 2. Daily / weekly health checks

- **API up:** `curl -sS https://tokenosdeai-api.onrender.com/v1/health` returns 200
- **Stats sanity:** `curl -sS https://tokenosdeai-api.onrender.com/v1/public/stats` returns non-zero `totalNodesOnline`
- **Worker heartbeat (in Render logs):** look for `[per-minute-meter]`, `[reputation-scorer]`, `[spot-preemption]`, `[seed-keep-alive]`, `[referral-commission]` lines firing on cadence
- **Recent payouts:** dashboard → settlements page → no rows stuck in PENDING > 30 min

## 3. Database backups

Render's managed Postgres takes automated daily backups; the manual
backup script also exists for marquee events (pre-migration, pre-launch).

### Take a manual backup

From the Render shell on the API instance:

```bash
./apps/api/scripts/backup-db.sh
```

Writes a timestamped `pg_dump` to the S3 bucket configured in env
`BACKUP_S3_BUCKET`. Filename: `a2e-YYYYMMDDTHHmmss.sql.gz`.

### Restore a backup

```bash
./apps/api/scripts/restore-db.sh s3://<bucket>/a2e-<timestamp>.sql.gz
```

Restores into the database pointed at by `DATABASE_URL`. **Do not run
against production** unless you're recovering from an incident; this is
destructive.

## 4. Rate limit configuration

Defined in `apps/api/src/plugins/rate-limit.ts`. Tunable via env:

- `RATE_LIMIT_MAX` — requests per window (default 100)
- `RATE_LIMIT_WINDOW_MS` — window in ms (default 60_000)

Public routes apply the limit; authenticated portal routes are exempt.
If you see 429s in legitimate traffic, raise `RATE_LIMIT_MAX` on the
Render env and redeploy.

## 5. Admin auth

The dashboard uses JWT auth (M1 replaced the Phase 1 HMAC token). To
mint a fresh admin token: log into the dashboard normally, then read
`localStorage.a2e_access_token` from devtools. The token is short-lived
(15 min); use the refresh token in localStorage for longer sessions.

For curl-based admin operations:

```bash
curl -H "Authorization: Bearer <token>" https://tokenosdeai-api.onrender.com/v1/...
```

## 6. Per-feature operational notes

### Referrals (M5.7)

- **Env knobs:**
  - `REFERRAL_COMMISSION_PCT` (default 0.10)
  - `REFERRAL_WINDOW_DAYS` (default 365)
  - `REFERRAL_COMMISSION_TICK_MS` (default 24h)
  - `REFERRAL_IP_CHECK_ENABLED` (default 1; set to 0 in dev)
  - `REFERRAL_REFERRER_CAP_USD` (default 5000; set to 0 to disable)
- **Manual trigger:** `pnpm --filter @a2e/api referrals:recompute`
- **End-to-end test:** `pnpm --filter @a2e/api referrals:test-flow <email>`
- **Un-revoke a flagged referral** (admin override after manual review):
  ```sql
  UPDATE "Referral" SET status = 'ACTIVE' WHERE id = '<referral-id>';
  ```

### Carbon reporting (M5.8)

- **Backfill historical rentals:** `pnpm --filter @a2e/api backfill:co2`
- **Adjust GPU TDP or region intensity:** edit
  `packages/core/src/carbon-estimator.ts` and redeploy

### Spot preemption (M3.6)

- 30s tick. Grace 90s. Tunable via `SPOT_PREEMPTION_TICK_MS` and
  `SPOT_PREEMPTION_GRACE_MS`.
- To pause the worker entirely during incident response: set
  `SPOT_PREEMPTION_DISABLED=1` and redeploy.
- Refund behavior: SPOT rentals paid via USDC get a prorated Solana
  refund; rentals paid via internal balance are rebated by mutating
  the `InternalSpend.amount` row (no Solana hop). RESERVED tier is
  preemption-exempt.

### Seed keep-alive (test-only)

- Currently ENABLED via `SEED_KEEP_ALIVE_ENABLED=1`.
- **Must be disabled** before public launch so fake seed inventory
  stops competing with real node agents. Unset the env var and
  redeploy.

### Custodial payouts (M3 / launch-blocker family)

The platform holds operator earnings until the operator withdraws on
demand. Driven by `apps/api/src/services/settlement/engine.ts`.

- **Cool-down window:** earnings sit in `pending` state for
  `PAYOUT_COOLDOWN_HOURS` (default 2) after they accrue, then move to
  `available`. Only `available` is withdrawable.
- **Payout modes** (per-operator on `NodeRunner.payoutMode`):
  - `AUTO` — settlement worker fires on schedule when balance crosses
    `payoutThreshold`
  - `MANUAL` — accumulate indefinitely; operator clicks Withdraw Now
    in the portal
  - `SCHEDULED` — accumulate until `payoutScheduledAt`, then fire and
    reset to AUTO (one-shot)
- **Safety nets** (force a payout regardless of mode):
  - Platform balance cap: `PAYOUT_BALANCE_CAP_USD` (default 50000)
  - Inactivity sweep: `PAYOUT_INACTIVITY_DAYS` (default 180)
- **Admin payout lock** (used during buyer disputes / fraud
  investigation): on the admin operator detail page, click "Lock
  payouts", pick an unlock date + reason. While set and in the future,
  both the settlement worker and the Withdraw Now endpoint refuse for
  this operator. Reason is surfaced to the operator on their
  `/payouts/settings` page so they understand why.
- **Withdraw Now wallet override:** the dialog lets the operator send
  to a different wallet than the saved profile wallet, with an
  optional "save this wallet to my profile" checkbox.

### BYOG install tokens (launch-blocker #1)

One-shot tokens that authorize a single `curl | bash` install on the
operator's GPU machine. Stored on `InstallToken` model.

- **Mint:** operator clicks "+ Add Node" in `/nodes` on the portal,
  optionally picks a region. Token TTL is 7 days. Returns a
  `curl -fsSL https://<api>/v1/byog/install?token=... | bash` one-liner.
- **Claim:** the install.sh script calls `POST /v1/byog/claim` with
  the token + GPU specs. On success a permanent `a2e-node-*` API key
  is issued and the token is marked consumed.
- **Admin revoke:** `/install-tokens` page on the admin dashboard
  lists every minted token with status (ACTIVE/CONSUMED/EXPIRED).
  Click Revoke on an ACTIVE row to soft-kill the curl URL (sets
  `expiresAt` to the past). Consumed tokens cannot be revoked — pause
  or delete the resulting node from `/nodes` instead.
- **API:** `DELETE /v1/admin/install-tokens/:id` — 409 if already
  consumed.

### Workspace checkpoints (M3-T6)

Buyers can snapshot the per-rental workspace (`/home/<sshUsername>` on
the operator's box) to S3 and restore it on a future rental. Drives
the **Checkpoint Workspace** button on the buyer's active rental card
and the optional `restoreCheckpointId` field on `POST /v1/buyer/compute/request`.

**Env config** (required to enable the feature, set in Render `a2e-api`):
- `CHECKPOINT_S3_BUCKET` — S3 bucket name
- `CHECKPOINT_S3_REGION` — default `us-east-1`
- `CHECKPOINT_AWS_ACCESS_KEY_ID` — IAM access key with PutObject/GetObject/HeadObject on the bucket
- `CHECKPOINT_AWS_SECRET_ACCESS_KEY` — secret
- `CHECKPOINT_S3_ENDPOINT` — optional, for S3-compatible services like R2 or Minio
- `CHECKPOINT_PRESIGN_TTL_SECONDS` — default 3600 (1h); how long the presigned URLs stay valid

When the env is unset, the buyer's Checkpoint button still works (the
ComputeRequest row flips to `checkpointStatus=REQUESTED`) but the
agent's upload-URL request returns 503 and the snapshot stays in
REQUESTED forever. UI shows the row but never advances to READY.

**Round-trip flow:**
1. Buyer clicks Checkpoint on `/buyer/active` → `POST /v1/buyer/compute/requests/:id/checkpoint` → row flips to `REQUESTED`
2. Agent's next heartbeat receives `workspaceCheckpoint: { action: 'checkpoint', ... }`
3. Agent reports UPLOADING, tars `/home/<username>`, requests `POST /v1/agent/checkpoints/upload-url`
4. Agent PUTs the tar.gz to the presigned URL
5. Agent reports READY with the bucketUrl + checkpointId → row stores both
6. Buyer creates a new rental with `restoreCheckpointId=<id>` → row stores it
7. Agent's heartbeat on the new node receives `workspaceCheckpoint: { action: 'restore', ... }`
8. Agent requests `POST /v1/agent/checkpoints/:checkpointId/download-url`, GETs the tar.gz, untars to the buyer's home directory
9. Agent reports restore-applied → heartbeat stops surfacing the action

**S3 object key convention:** `checkpoints/<nodeRunnerId>/<computeRequestId>/<checkpointId>.tar.gz` — admin can filter / audit per-operator from the S3 console.

**Workspace exclusions:** the agent's tar skips `.cache`, `node_modules`, and `__pycache__` to keep snapshots small. If a buyer's workflow depends on these, document it as a known gap.

**Cleanup:** S3 objects are not auto-deleted. Run an S3 lifecycle policy on the bucket (e.g. expire objects older than 90 days) to bound storage cost.

### Benchmarking (C4 wave 1)

One-click GPU benchmark from the operator's `/nodes/<id>` page. The
node-agent pulls a public Docker image, runs CUDA matmul + VRAM
bandwidth tests, scores against tier baselines, reports back. A score
drop >20% versus the prior run fires a `NODE_DEGRADED` notification
to alert the operator about thermal / driver / power throttling.

**Benchmark image:** `ghcr.io/stackmerth/a2e-benchmark:latest` (public,
~6 GB pulled). Source lives in [apps/node-agent/benchmarks/](apps/node-agent/benchmarks/).
Override per-environment with `BENCHMARK_IMAGE` env on the agent.

**Round-trip flow:**
1. Operator clicks **Run benchmark** on `/nodes/<id>` (portal)
2. `POST /v1/portal/node-runner/nodes/:id/benchmark` writes a Config
   row with key `benchmark:request:<nodeId>` (one-shot flag)
3. Agent's next heartbeat receives `benchmark: { action: 'run' }`
4. Agent calls `docker pull` (no-op if cached) then `docker run
   --rm --gpus all ghcr.io/stackmerth/a2e-benchmark:latest`
5. Agent parses last JSON line of stdout, posts to
   `/v1/nodes/:id/benchmark/result`
6. API updates Node row (score + 2 metric cols + lastBenchmarkAt),
   deletes the Config flag, emits `node:benchmark` WS event for live
   UI refresh
7. If `priorScore` was non-null AND new score is >20% lower → fires
   `NODE_DEGRADED` notification (email + bell)

**Mock mode for QA without a GPU:** set `BENCHMARK_MOCK_RESULT` on
the agent to a JSON string like
`'{"matmulTflops":300,"vramBandwidthGbs":2000,"score":92,"gpuName":"MOCK H100"}'`.
The manager skips Docker entirely and reports the mock value. Lets
the API + UI + notification path be tested end-to-end without
spinning up RunPod.

**Cooldown:** 5 min between runs (set via `BENCHMARK_COOLDOWN_MS`).
Server enforces; UI also disables the button client-side for snappy
feedback. Prevents accidental hammering — a benchmark holds the GPU
exclusively for ~3 min so back-to-back runs would block real
buyer workloads.

**Expected score ranges per tier:**
| GPU | Expected score |
|---|---|
| H100 80GB HBM3 | 85-100 |
| H200 | 90-100 |
| B200 / B300 / GB300 | 90-100 |
| RTX 4090 24GB | 80-100 |
| RTX 3090 24GB | 75-100 |
| A100 80GB | 80-95 |

**Manual recovery:** if the Config flag gets stuck (agent died
mid-run, never cleared the flag), delete it from psql:
```sql
DELETE FROM "Config" WHERE key LIKE 'benchmark:request:%';
```

**Anomaly threshold tuning:** `BENCHMARK_ANOMALY_THRESHOLD_PCT` env
on the API service (default 20). Tighten to 15 if false negatives
dominate; loosen to 30 if you're getting noise from normal run-to-run
variance.

**Future:** publish benchmark score on the public operator profile
([apps/marketplace/src/app/operator/[slug]/page.tsx](apps/marketplace/src/app/operator/[slug]/page.tsx))
as "Verified performance: 87/100" alongside the reputation badge.
Not yet wired — small follow-up.

### Tax / 1099 reporting (C7 wave 1)

US-only first iteration. Operators self-attest W-9 data via
[`/payouts/settings`](apps/portal/src/app/(node-runner)/payouts/settings/page.tsx)
→ **Tax info** card, then download per-year CSVs suitable for handing
to a CPA for 1099-MISC prep.

**Data stored on `NodeRunner`** (all nullable):
- `legalName` — name on tax filings
- `taxId` — raw TIN (SSN 9 digits or EIN 9 digits, with or without dashes)
- `taxIdType` — `SSN` | `EIN`
- `taxAddress` — single-line US-style address
- `taxJurisdiction` — defaults `US`; non-US disabled in UI (W-8BEN path is a future addition)
- `w9SubmittedAt` — set on the first successful PATCH

**Read paths mask the TIN to last-4** so a leaked browser session
doesn't expose the full id. Full value lives in the DB column for the
CSV export.

**CSV shape** (see [tax-csv.ts](apps/api/src/services/reports/tax-csv.ts)):
- Operator-header row (1 line, pre-filled from NodeRunner tax fields)
- Blank separator
- Per-month breakdown for the tax year (12 rows + TOTAL)
- Each month: gross USD, settlement count, semicolon-separated payout TX hashes

Settlements counted via `Settlement.status='COMPLETED' AND periodEnd
∈ [yearStart, yearEnd)`. Year start/end are UTC midnight on Jan 1.

**Endpoints:**
- `GET /v1/portal/node-runner/tax-info` — masked read
- `PATCH /v1/portal/node-runner/tax-info` — save W-9 (sets `w9SubmittedAt`)
- `GET /v1/portal/node-runner/tax/year/:year` — CSV download; 400 if year > current, 404 if no settlements

**Year-end ops checklist:**
- Run a Postgres query in late January to find operators with annual
  earnings > $600 (the 1099-MISC threshold) AND `w9SubmittedAt = NULL`:
  ```sql
  SELECT nr.id, nr.email, SUM(s.amount) AS gross
  FROM "NodeRunner" nr
  JOIN "Node" n ON n."nodeRunnerId" = nr.id
  JOIN "Settlement" s ON s."nodeId" = n.id
  WHERE s.status='COMPLETED' AND s."periodEnd" >= '<YEAR>-01-01' AND s."periodEnd" < '<YEAR+1>-01-01'
    AND nr."w9SubmittedAt" IS NULL
  GROUP BY nr.id, nr.email
  HAVING SUM(s.amount) >= 600;
  ```
- Email those operators a reminder to fill in their W-9 so their CSV is complete.

**Known gaps + follow-ups:**
- **Encryption at rest** — `taxId` is plain text in the DB. Recommend
  `pgcrypto` extension + AES-GCM column encryption (~half day to add).
  Track via the existing risks register in the plan.
- **W-8BEN for non-US operators** — same schema shape, different
  header columns. ~2 days when first international operator signs up.
- **Auto-file 1099s** — out of scope. Platform doesn't file with the
  IRS; operators are responsible for using the CSV with their CPA.

### Internal-spend (dual-role buyers paying from operator balance)

Users who are both `isBuyer=true` AND `isNodeRunner=true` can pay for
rentals from their accumulated platform balance instead of USDC. Stored
on `InternalSpend` model (1:1 with `ComputeRequest` via
`computeRequestId`).

- **Buyer UX:** the `/buyer/request` form renders a "Payment method"
  card when `GET /v1/buyer/compute/internal-balance` returns
  `eligible: true`. Picking "Operator balance" hides the tx hash input
  and shows a live debit preview.
- **Atomic write:** `POST /v1/buyer/compute/request` with
  `paymentSource=INTERNAL_BALANCE` checks available balance (returns
  402 if short), then creates the `ComputeRequest` + `InternalSpend`
  row + sets `txHash=INTERNAL:<computeRequestId>` in one transaction.
- **Balance math:** `getOperatorBalanceBreakdown` subtracts the
  lifetime sum of `InternalSpend.amount` from raw earnings to give
  `available`. The Withdraw Now route pro-rates per-node settlements
  down to `available` so the wallet never gets more than what's
  actually owed.
- **Refund on terminate:** for INTERNAL_BALANCE rentals, early
  termination mutates `InternalSpend.amount` to the final accrued cost
  instead of attempting a Solana refund. RESERVED tier still
  forbids refund.
- **Operator visibility:** `/payouts` shows an "Internal Spend" panel
  listing recent spend rows; `/payouts/settings` adds a "Spent on
  rentals" tile alongside Available + Pending.

## 7. Payments / settlements

### Solana

- **Mode:** `PAYMENT_MODE` env (`dev` = devnet, `live` = mainnet).
- **Helius:** `HELIUS_API_KEY` env. Currently on free tier; upgrade to
  Developer ($49/mo) once active buyer count exceeds ~100 or
  rate-limit signals appear in logs.
- **Webhook URL** at Helius dashboard: `https://tokenosdeai-api.onrender.com/v1/webhooks/solana`

### Payer key

- Source of truth: `SOLANA_PAYER_KEY` env var (Render API service).
  The engine reads from env exclusively (see
  `apps/api/src/services/payment/solana.ts`).
- The legacy `SettlementConfig.payerPrivateKey` DB column is no longer
  read. If a historical value still sits there, null it as
  defense-in-depth — see "Ad-hoc maintenance scripts" below.
- To rotate the live key: bump `SOLANA_PAYER_KEY` in Render env,
  redeploy. The new keypair becomes active on next process start.

## 7a. Ad-hoc maintenance scripts

Run from the **Render API service web shell** (`a2e-api` service →
Shell tab). All scripts use the API service's `DATABASE_URL` so they
hit prod safely.

```bash
cd /opt/render/project/src/apps/api
pnpm null:payer-key                  # one-off: blank stale SettlementConfig.payerPrivateKey
pnpm seed:earnings <email>           # targeted: 24h heartbeats + earning rollups on ONE operator
                                     # (safe against prod; wipes prior test data first; for QA L4)
pnpm preempt:test <email> [--internal] # QA: synthesizes ACTIVE SPOT rental, marks for immediate
                                     # preemption, triggers worker tick directly, reports refund
                                     # outcome. --internal uses INTERNAL_BALANCE paymentSource.
pnpm seed:test                       # bulk fixture seeder — REFUSES prod; dev only
pnpm seed:keep-alive-only            # legacy: long-running keep-alive (use env flag instead)
pnpm reputation:recompute            # force a reputation pass outside the daily worker
pnpm referrals:recompute             # force a referral commission tick
pnpm backfill:co2                    # backfill CO2 estimates on historical rentals
```

The `seed:earnings` script is the right tool for QA tests against prod (it only touches one named operator's heartbeats + earning rollups, and re-running wipes prior test data so each run starts clean). `seed:test` is the dev-mode bulk fixture seeder that creates fake users/nodes — it refuses to run against a prod DATABASE_URL unless `ALLOW_PROD_SEED=1` is set.

Each script is idempotent — safe to run twice. Adding new scripts:
drop a tsx file in `apps/api/scripts/` and a matching npm entry in
`apps/api/package.json`.

## 8. Scaling levers

- **API CPU bound** → Render: bump plan
- **Postgres connection cap** → Render: increase pool, or shard reads
  through Prisma Accelerate
- **Redis memory pressure** → Render: bump plan; BullMQ queues hold
  recent jobs by default
- **Worker queue depth** → check BullMQ inspector via Render logs; tune
  the per-queue `removeOnComplete.count` if backlog grows

## 9. Common incidents

### "Listings page is empty"

1. `curl https://tokenosdeai-api.onrender.com/v1/public/listings` — is the API returning data?
2. If yes, hard-refresh the marketplace (Vercel ISR cache 60s)
3. If no, check `seed-keep-alive` log: are heartbeats fresh?
4. Last resort: `pnpm --filter @a2e/api seed:test:keep-alive` from Render shell

### "Carbon estimate shows 0"

- Historical rentals never went through the new meter. Run
  `pnpm --filter @a2e/api backfill:co2` once.

### "Leaderboard referrers tab empty even after a Referral exists"

- Check that the referrer's NodeRunner has a `slug` set:
  ```sql
  SELECT id, name, slug, "referralCode" FROM "NodeRunner" WHERE id = '<id>';
  ```
- If slug is null, the operator can fix by visiting `/referral` once
  (auto-runs `ensureSlug` as a side effect).

### "Vercel build failed: cloning the repo"

- GitHub transient 500. Click "Redeploy" in Vercel; pushing an empty
  commit is wasteful.

### "Operator's Withdraw Now button is greyed out / 409"

1. Check the breakdown: `GET /v1/portal/node-runner/payouts/mode` as
   the operator. If `available === 0`, there's nothing past the
   cool-down yet. Pending amount + `nextUnlockAt` show when the next
   chunk frees up.
2. Check for an admin payout lock: on the operator detail page in
   admin, is there a red "Payouts locked" banner? Reason is shown in
   the banner. Click Clear lock if appropriate.
3. Internal-spend may have eaten the available pool. Check the Spent
   tile on `/payouts/settings` — operator may have to wait for fresh
   accrual to clear the cool-down.

### "Operator wants to revoke an install token they accidentally shared"

1. Admin dashboard → `/install-tokens` → find the row (filter by
   operator name / status ACTIVE)
2. Click Revoke → confirm in the dialog
3. Token's `expiresAt` is set to the past; next curl|bash hit returns
   `# Install token expired; mint a fresh one from the portal.`
4. Operator can mint a fresh one from `/nodes` in the portal whenever
   they're ready.
5. If the token has already been consumed (CONSUMED badge), revoke is
   refused with 409 — pause or delete the resulting Node from
   `/nodes` instead.

### "Dual-role user gets 403 on /v1/buyer/* despite having isBuyer=true"

- Pre-`a1c2812` builds only checked the legacy `User.role` JWT claim.
  Confirm the API is running `a1c2812` or later — if so, the dual-
  identity slow path takes one DB hit per request and recognizes the
  `isBuyer` / `isNodeRunner` / `isAdmin` flags.
- If still 403 after deploy, check `User.isBuyer` is actually `true`
  in the DB (not just `role`).

### "Internal-spend rental terminated but operator's balance didn't go back up"

- Check the `InternalSpend` row: should be updated, not deleted.
  ```sql
  SELECT s.id, s.amount, c.id AS rental, c.status, c."completedAt"
  FROM "InternalSpend" s
  JOIN "ComputeRequest" c ON c.id = s."computeRequestId"
  WHERE c.id = '<rental-id>';
  ```
- For COMPLETED rentals, `InternalSpend.amount` should equal
  `finalAccrued` (a fraction of original totalCost).
- RESERVED tier intentionally does NOT refund — commitment is honored
  regardless of payment source.

## 10. Where to file new issues

- Code bugs: GitHub issues on `StackMerth/a2e-neo-nodes`
- Incidents (paging): wherever you have your alerting set up
- Feature requests: backlog in the plan file at
  `~/.claude/plans/binary-plotting-rocket.md`
