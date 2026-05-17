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
