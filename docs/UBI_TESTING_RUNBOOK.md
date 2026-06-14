# ZK-UBI testing runbook

This runbook lets you exercise the full ZK-UBI flow end-to-end against the simulator, without any of the funded sub-tasks (M2.1 ZKC stake, M2.2 broker deploy, M2.4 Bento auth).

Everything below runs against the live API on `tokenosdeai-api`. No local dev setup required.

## What you can test today

| Layer | What's exercisable | What's stubbed |
|---|---|---|
| Opt-in flow | Create / list / opt-out `NodeUbiOptIn` rows | Operator-facing portal UI (M3) |
| Proof accrual | Inject synthetic `UbiProof.ACCEPTED` rows + run them through the real `processFulfillEvent` handler | The live Base chain event reader (no broker) |
| Swap rail | Watch the placeholder ETH → USD conversion run on each synthetic proof | Real Uniswap V3 swap on Base (M2.6b) |
| Epoch close | Roll up N accepted proofs into a single `UbiEarning` row with 95/5 split | Real epoch-bound ZKC claim flow (M5) |
| Cleanup | Wipe all simulator rows in one call | n/a — simulator-tagged rows are safe to delete |

## Prereqs

You need:
1. Admin JWT — grab one from the portal DevTools network tab (same as the V-E test earlier)
2. A node ID that exists in production — query with `prisma.node.findFirst()` on Render shell if needed
3. `curl` + `jq` for nice output

Set them once at the top of your shell:

```bash
export JWT='paste-your-admin-jwt-here'
export NODE_ID='paste-a-real-node-id-here'
export API='https://a2e-api.onrender.com'
```

## Step 1 — Opt the node into ZK-UBI

```bash
curl -sS -X POST "$API/v1/admin/ubi/opt-in" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\",\"protocol\":\"BOUNDLESS\"}" | jq
```

Expected:
```json
{ "ok": true, "optInId": "cm...", "created": true }
```

A second call with the same nodeId returns `"created": false` and the same `optInId` — opt-in is idempotent.

## Step 2 — Inject synthetic accepted proofs

Each call injects a fake Boundless fulfill event and runs it through the real `processFulfillEvent` handler. Default value: ~$1 per proof at the placeholder $3,500/ETH price.

```bash
# One proof
curl -sS -X POST "$API/v1/admin/ubi/simulate/proof" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\",\"count\":1}" | jq

# Batch of 25
curl -sS -X POST "$API/v1/admin/ubi/simulate/proof" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\",\"count\":25}" | jq
```

Expected:
```json
{
  "ok": true,
  "requested": 25,
  "accrued": 25,
  "skipped": 0,
  "sample": [
    { "accrued": true },
    { "accrued": true },
    ...
  ]
}
```

If any returned `accrued: false` with reason `duplicate`, the simulator collided on a request id (very unlikely with the timestamp+random ID scheme — repeat the call).

### Variant: different proof value

Override `feeWei` to test a different proof size. Decimal or hex string both work. Wei is 10^18 per ETH.

```bash
# A "fat" $100 proof
# 100 / 3500 = 0.0286 ETH = 28571428571428571428 wei
curl -sS -X POST "$API/v1/admin/ubi/simulate/proof" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\",\"feeWei\":\"28571428571428571428\",\"count\":1}" | jq
```

## Step 3 — Close the epoch (roll up to a UbiEarning row)

```bash
curl -sS -X POST "$API/v1/admin/ubi/simulate/epoch" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\"}" | jq
```

Expected:
```json
{
  "ok": true,
  "earningId": "cm...",
  "proofsRolled": 26,
  "grossUsd": 26.5714,
  "operatorUsd": 25.2428,
  "platformUsd": 1.3286
}
```

Verify the math: `operatorUsd / grossUsd ≈ 0.95`, `platformUsd / grossUsd ≈ 0.05`.

A second call right after returns `proofsRolled: 0` (nothing new since the prior periodEnd). Inject more proofs (step 2) and call again to roll up the next window.

## Step 4 — Inspect platform state

```bash
curl -sS "$API/v1/admin/ubi/status" \
  -H "Authorization: Bearer $JWT" | jq
```

Returns:
- `activeOptIns` — count of opt-ins per protocol
- `recentProofs` — last 25 `UbiProof` rows across the platform
- `recentEarnings` — last 25 `UbiEarning` rows (the rolled-up ledger)
- `protocolSummary` — sum of grossUsd per (protocol, status)

## Step 5 — Wipe everything before the next test run

```bash
curl -sS -X POST "$API/v1/admin/ubi/simulate/purge" \
  -H "Authorization: Bearer $JWT" | jq
```

Returns:
```json
{
  "ok": true,
  "proofsDeleted": 26,
  "earningsDeleted": 1,
  "optInsDeleted": 1
}
```

Only rows tagged `aggregator: 'SIMULATOR'` and `consentVersion: 'simulator-v0'` are touched. Production rows are safe.

## End-to-end smoke test (one paste)

Run after `JWT`, `NODE_ID`, `API` are set:

```bash
echo "=== 1. opt-in ==="
curl -sS -X POST "$API/v1/admin/ubi/opt-in" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\"}" | jq

echo "=== 2. simulate 10 accepted proofs ==="
curl -sS -X POST "$API/v1/admin/ubi/simulate/proof" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\",\"count\":10}" | jq

echo "=== 3. roll up to UbiEarning ==="
curl -sS -X POST "$API/v1/admin/ubi/simulate/epoch" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_ID\"}" | jq

echo "=== 4. status ==="
curl -sS "$API/v1/admin/ubi/status" -H "Authorization: Bearer $JWT" | jq '.recentEarnings[0], .protocolSummary'

echo "=== 5. purge ==="
curl -sS -X POST "$API/v1/admin/ubi/simulate/purge" \
  -H "Authorization: Bearer $JWT" | jq
```

PASS criteria:
- Step 1 returns `optInId` (string) and `created: true`
- Step 2 returns `accrued: 10`
- Step 3 returns `proofsRolled: 10`, `grossUsd ≈ 10`, `operatorUsd ≈ 9.5`, `platformUsd ≈ 0.5`
- Step 4 shows the earning row and a `protocolSummary` row for `{protocol: BOUNDLESS, status: ACCEPTED}` with `_sum.grossUsd ≈ 10`
- Step 5 returns `proofsDeleted: 10`, `earningsDeleted: 1`, `optInsDeleted: 1`

## What this proves vs. what it doesn't

**Proves the simulator covers:**
- Schema correctness (rows write + read cleanly)
- 95/5 split math
- Idempotency on (protocol, externalProofId)
- Cleanup hygiene
- Admin gating (only admin JWTs hit the routes)

**Does NOT prove (gated on M2.1 + M2.2):**
- Real Base chain event decoding (the reader is stubbed)
- Real Uniswap swap execution (the swap rail is stubbed)
- Real Boundless broker integration
- Real ZKC stake + collateral lifecycle
- Real epoch close timing

To progress to the second column, fund M2.1 and deploy M2.2. Until then, the simulator faithfully mimics the row writes the live path will produce.

## Operator-facing UI verification (after M3 ships)

Step 6 will land once M3 ships the operator portal page:
- Operator logs into portal
- Sees "ZK-UBI: opt in" pitch on operator dashboard
- Clicks opt-in → `NodeUbiOptIn` ACTIVE row appears
- Simulator runs in the background (step 2 + 3 above)
- Operator dashboard shows accrued USD updating in near-realtime

Verification will hook into the existing operator earnings dashboard plus a new "ZK-UBI earnings" card.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | JWT expired or not admin | Re-grab JWT from portal DevTools; verify the user has ADMIN role |
| `validation_error` | Missing `nodeId` or invalid protocol enum | Check request body |
| `accrued: 0` with no `reason` | Node has `assignedComputeRequestId` set; race with rental | Pick a different idle node |
| `proofsRolled: 0` after step 3 | All accepted proofs already rolled up | Inject more proofs (step 2) first |
| Step 5 returns `proofsDeleted: 0` | No simulator rows present (already purged) | Expected after a clean run |
