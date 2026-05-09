# A²E Testing Guide

This document is a structured walkthrough of every feature of the platform that
should be exercised during a QA pass. It assumes the production seed has been
run (see "Seeding test data" below) so that all dashboards are populated with
realistic data instead of empty zeros.

## Seeding test data

Run once from a Render shell on the `a2e-api` service:

```
ALLOW_PROD_SEED=1 pnpm --filter @a2e/api seed:test
```

The script is idempotent. Re-run any time to reset test passwords or bring
seed counts back to expected values.

For continuous heartbeats so live nodes stay ONLINE:

```
ALLOW_PROD_SEED=1 pnpm --filter @a2e/api seed:keep-alive-only
```

Leave this running in a separate shell during the test session. Without it,
the node-health worker will demote the seeded ONLINE nodes to OFFLINE within
90 seconds.

## Test credentials

| Role | URL | Email | Password |
|---|---|---|---|
| Admin | a2e-admin.stackforgelab.tech | `admin` | (set on Render `ADMIN_PASSWORD`) |
| Node Runner | a2e-user.stackforgelab.tech | `noderunner@tokenos.ai` | `NodeRunner2026` |
| Compute Buyer | a2e-user.stackforgelab.tech | `buyer@tokenos.ai` | `Buyer2026!!` |
| Compute Buyer 2 | a2e-user.stackforgelab.tech | `buyer2@tokenos.ai` | `Buyer2026!!` |

## Suggested test order

Open three browsers (or three private windows so cookies don't collide), each
logged in as a different role. Walk through the steps below in this order so
the cross-role interactions can be observed.

---

## Admin Dashboard

URL: https://a2e-admin.stackforgelab.tech

### 1. Overview

- [ ] Header shows current date and live event ticker.
- [ ] Header stats: total nodes (25), online nodes (~12), pending compute requests, recent settlements.
- [ ] Live activity feed shows recent events (heartbeats, routing decisions, settlements).

### 2. Nodes page

- [ ] List view shows all 25 nodes, sortable by status, GPU tier, region, last heartbeat.
- [ ] Status filter chips (ONLINE / DEGRADED / OFFLINE / PAUSED / MAINTENANCE) update the table.
- [ ] Click into any node → detail page shows recent heartbeats, GPU metrics over time, current job (if any), node runner owner.
- [ ] "Add Node" button shows install command with the new API URL (a2e-api.onrender.com), not the old byredstone URL.

### 3. Node Runners page

- [ ] Lists `Seed Test Runner` (the seeded node-runner account) plus any accounts you created.
- [ ] Click into the node runner → see their nodes, total earnings, withdrawal history.

### 4. Compute Requests page

- [ ] Pending tab shows `buyer@tokenos.ai` and `buyer2@tokenos.ai` requests waiting for review.
- [ ] Approve a PENDING request → status flips to APPROVED. Buyer's portal sees the change in real-time via WebSocket.
- [ ] Allocate an APPROVED request → pick from available nodes → status flips to ALLOCATED, SSH credentials are issued.

### 5. Routing Decisions

- [ ] Recent decisions log shows market choice (INTERNAL / AKASH / IONET / VASTAI), GPU tier, rate, reason text.
- [ ] Filter by market → list narrows.
- [ ] Yield-floor-applied flag is visible on rows where it kicked in.

### 6. Market Rates

- [ ] Live rate cards show all 5 GPU tiers across each enabled market (IONET + VASTAI; AKASH is bypassed).
- [ ] Last-fetched timestamp updates roughly every 60 seconds (the rate-fetcher cadence).

### 7. Settlements

- [ ] List shows seeded settlements in COMPLETED / PENDING / FAILED states.
- [ ] Click into a settlement → see line items per node, total amount, Solana tx hash (test_tx_*).
- [ ] Retry a FAILED settlement → enters PROCESSING state.

### 8. Payments

- [ ] List of Solana payouts. Each row shows status (PENDING / SENT / CONFIRMED / FAILED).
- [ ] In dev mode, tx hashes are `DEV_...` placeholders. In live mode (after Phase 1 completion item ships), real Solana tx hashes appear.

### 9. Withdrawals page

- [ ] One PENDING request waiting for admin approval.
- [ ] Approve → flips to APPROVED → can be processed.
- [ ] Reject → flips to REJECTED with reason.

### 10. External Deployments

- [ ] AKASH deployment shows ACTIVE (one seeded).
- [ ] IONET shows PENDING.
- [ ] VASTAI shows TERMINATING (the SAFE-mode grace window).
- [ ] Click delist on any ACTIVE → enters TERMINATING.

### 11. Investments

- [ ] Five seeded investments visible, one in each state.
- [ ] DEPLOYMENT_REQUESTED has a deployment note from the node runner.
- [ ] Click into DEPLOYING → shows the failed ProvisionJob with error log.

### 12. Audit Log

- [ ] Recent entries for every state-changing action: Settlement.statusChange, Investment.update, ComputeRequest.approve, etc.
- [ ] Each entry has actor (USER / SYSTEM / API), timestamp, previous + new value.

### 13. Configuration

- [ ] Yield floor rates editable per GPU tier.
- [ ] Market enable/disable toggles.
- [ ] Settlement schedule (period, day of week, hour, minimum payout).
- [ ] Overflow config (idle threshold, demand threshold, margin protection, grace period).

### 14. Reports

- [ ] CSV export for earnings, settlements, jobs, nodes — downloads a real .csv.
- [ ] PDF export for invoices — downloads a real .pdf with proper formatting.
- [ ] Per-node statement opens an HTML report in a new window.

### 15. System

- [ ] Service health (DB, Redis, queue depths).
- [ ] Workers list shows all 11 BullMQ workers actively running.

---

## Node Runner Portal

URL: https://a2e-user.stackforgelab.tech

Sign in as `noderunner@tokenos.ai` / `NodeRunner2026`.

### 1. Dashboard

- [ ] Total Earnings shows non-zero (~$1k–$5k from the 30-day seed).
- [ ] Active Nodes / Total Nodes shows ratio (e.g. 12 / 25).
- [ ] Uptime % > 0 (computed from heartbeats).
- [ ] Earnings widget shows Today / Week / Month / All Time tabs with real numbers.
- [ ] Daily Earnings chart for last 30 days has data points.

### 2. Nodes

- [ ] List of 25 nodes assigned to this runner.
- [ ] Status, GPU tier, region, last heartbeat columns populated.
- [ ] Click into a node → heartbeat chart, GPU utilization graph, current job, recent earnings.

### 3. Earnings

- [ ] Total earnings broken down by market (INTERNAL / AKASH / IONET / VASTAI).
- [ ] Per-tier breakdown shows H100, H200, B200 etc.
- [ ] Date range picker filters the data.

### 4. Payouts (Settlement history)

- [ ] List of past settlements with date, amount, status, tx hash.
- [ ] Pending settlements shown separately.

### 5. Withdrawals

- [ ] Existing seeded request showing PENDING / APPROVED / COMPLETED / REJECTED states.
- [ ] "Request Withdrawal" form: amount, wallet address (defaults to runner's wallet), submit.
- [ ] New request appears in admin queue immediately (visible in admin dashboard).

### 6. Reputation (no UI yet, planned for M3)

- [ ] Currently a placeholder. Will be the C1 deliverable.

### 7. Deploy

- [ ] Install command is shown with the new API URL, not byredstone.
- [ ] Copy-to-clipboard works.

### 8. Onboarding

- [ ] Step-by-step wizard: Requirements → Install → Verify.
- [ ] Verify step times out after 90 seconds with helpful failure copy if no actual GPU machine ran the install command.
- [ ] "Check now" button manually polls.

### 9. Settings

- [ ] Email, wallet address, payout threshold, payout frequency editable.
- [ ] Save persists; refresh shows updated values.

### 10. Notifications

- [ ] Bell icon shows unread count (from seeded notifications).
- [ ] Drop-down lists recent activity: payout sent, node offline, compute request approved.

---

## Compute Buyer Portal

Sign in as `buyer@tokenos.ai` / `Buyer2026!!`.

### 1. Dashboard

- [ ] Active rentals card shows current ACTIVE compute requests.
- [ ] Recent requests list with status badges.
- [ ] Total spend to date.

### 2. Request page

- [ ] GPU tier selector (H100 / H200 / B200 / B300 / GB300).
- [ ] GPU count input (1, 2, 4, 8 ...).
- [ ] Duration in days slider.
- [ ] Live price calculation (count × ratePerDay × days).
- [ ] Pay with Solana wallet flow → submits compute request → status PENDING.
- [ ] Buyer immediately sees their new request in the requests list.
- [ ] Admin sees the new request in the admin Compute Requests Pending tab.

### 3. Active rentals

- [ ] List shows ACTIVE compute requests.
- [ ] Each row has expiry countdown.
- [ ] Click into one → SSH command, allocated nodes, runtime.

### 4. Requests history

- [ ] All states represented (PENDING / APPROVED / ALLOCATED / ACTIVE / COMPLETED / REJECTED) from seed.
- [ ] Filter by status works.
- [ ] Click into a COMPLETED request → see total cost, nodes used, duration.

### 5. Billing

- [ ] Invoices list with monthly breakdown.
- [ ] Total spent across all rentals.
- [ ] Payment history with Solana tx hashes.

### 6. API Keys

- [ ] Create a new API key → key shown once, copyable, then masked.
- [ ] Programmatic test with the key:
  ```
  curl -H "X-API-Key: <key>" https://a2e-api.onrender.com/v1/buyer/dashboard
  ```
- [ ] Revoke a key → next API call with that key returns 401.

### 7. Settings

- [ ] Email, wallet address, default payment preferences.

### 8. Docs page

- [ ] OpenAPI-style endpoint reference.
- [ ] Real curl examples using the buyer's API key.

---

## Cross-portal interactions to verify

These are the flows that cross between admin / buyer / runner. Open each portal
in a separate browser window so you can see the live propagation.

### A. Compute request lifecycle

1. **Buyer**: submit a new compute request (1× H100 for 1 day).
2. **Admin**: see it appear in Compute Requests Pending within 1-2 seconds (WebSocket).
3. **Admin**: approve. Status flips to APPROVED.
4. **Buyer**: see the status change in real time without refresh.
5. **Admin**: allocate to specific nodes. SSH credentials issued.
6. **Buyer**: dashboard now shows ACTIVE rental with SSH command.

### B. Node deployment

1. **Node Runner**: visit /onboarding, copy install command.
2. **Admin**: visit Node Runners → see the runner. Click "Issue API key" if not present.
3. (Skipped: actual SSH provisioning to a real machine. The admin UI would be where this is triggered for production.)

### C. Withdrawal request

1. **Node Runner**: request withdrawal of $50.
2. **Admin**: see it in Withdrawals tab. Approve.
3. **Node Runner**: status changes to APPROVED.
4. **Admin**: process. (In dev mode, simulated tx hash. In live mode, real Solana transfer.)
5. **Node Runner**: status changes to COMPLETED with tx hash.

### D. Routing decision propagation

1. **Admin**: visit Routing Decisions.
2. Wait 60 seconds (the rate-fetcher tick).
3. New rates fetched from Vast.ai → MarketRate rows updated → live broadcast via WebSocket.
4. **Admin**: see new entry in market rates table.

### E. Settlement scheduling

1. **Admin**: open Configuration → Settlement schedule. Set autoSchedule = true, hour = current hour.
2. Wait for the next hourly tick (or trigger manually via the admin "Run Settlement Now" button if it exists).
3. **Admin**: see new Settlement rows created.
4. **Node Runner**: see new entry in Payouts.

---

## What's NOT covered by the seed

These flows require external systems and can't be exercised purely with seed
data. They will be addressed in later milestones.

| Flow | Why blocked | When unblocked |
|---|---|---|
| **Real SSH provisioning to a GPU host** | Needs an actual SSH-reachable Linux box with NVIDIA + Docker | When TokenOS supplies the GPU pipeline |
| **Real Solana settlements** | Needs payer wallet funded with USDC mainnet | Phase 1 completion item (free, ~2 hours config) |
| **Live Akash deployments** | SDK unstable, currently bypassed | When upstream stabilises |
| **Live IO.net deployments** | Live adapter not built in Phase 1 | Future engagement |
| **Live Vast.ai deployments** | Adapter exists but needs `VASTAI_ENABLED=true` + funded account | When TokenOS funds Vast.ai account (~$300 one-time) |
| **Real email delivery** | SMTP not configured | M1 task |

---

## Cleaning up after testing

The seed is fully deletable. To wipe all seeded data without dropping the
database:

```sql
DELETE FROM "Heartbeat" WHERE "nodeId" LIKE 'seed-node-%';
DELETE FROM "Earning" WHERE "nodeId" LIKE 'seed-node-%';
DELETE FROM "SettlementItem" WHERE "settlementId" IN (
  SELECT id FROM "Settlement" WHERE id LIKE 'seed-%'
);
DELETE FROM "Settlement" WHERE id LIKE 'seed-%';
DELETE FROM "Payment" WHERE "settlementId" LIKE 'seed-%';
DELETE FROM "Job" WHERE "nodeId" LIKE 'seed-node-%';
DELETE FROM "RoutingLog" WHERE "jobId" IN (
  SELECT id FROM "Job" WHERE "nodeId" LIKE 'seed-node-%'
);
DELETE FROM "Node" WHERE id LIKE 'seed-node-%';
DELETE FROM "ProvisionJob" WHERE id LIKE 'seed-pjob-%';
DELETE FROM "Investment" WHERE id LIKE 'seed-inv-%';
DELETE FROM "ExternalDeployment" WHERE id LIKE 'seed-ext-%';
DELETE FROM "WithdrawalRequest" WHERE "nodeRunnerId" = 'seed-noderunner-1';
DELETE FROM "ComputeRequest" WHERE "userId" IN (
  SELECT id FROM "User" WHERE email IN (
    'noderunner@tokenos.ai', 'buyer@tokenos.ai', 'buyer2@tokenos.ai'
  )
);
DELETE FROM "NodeRunner" WHERE id = 'seed-noderunner-1';
DELETE FROM "User" WHERE email IN (
  'noderunner@tokenos.ai', 'buyer@tokenos.ai', 'buyer2@tokenos.ai'
);
```

Run via `psql $DATABASE_URL -f cleanup.sql` from the Render shell. Or just
re-run the seed; it overwrites the existing rows in place.
