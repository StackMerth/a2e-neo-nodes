# A2E Buyer API

Programmatic access to the GPU compute marketplace. Use this to script
rentals, monitor cost, and integrate A2E into existing ML pipelines.

For interactive exploration, hit the Swagger UI:
<https://a2e-api.onrender.com/docs>

For the raw OpenAPI 3 document:
<https://a2e-api.onrender.com/docs/json>

---

## Authentication

Two paths.

**Public endpoints** (catalog, leaderboard, stats, feeds, operator
profiles) require no auth. Hit them with bare curl.

**Buyer endpoints** (request compute, terminate, billing) require a
Bearer JWT obtained from the portal login flow:

```bash
curl -X POST https://a2e-api.onrender.com/v1/portal/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"..."}'
```

Response:

```json
{
  "user": { "id": "...", "email": "...", "role": "COMPUTE_BUYER" },
  "accessToken": "eyJ...",
  "refreshToken": "..."
}
```

Use the `accessToken` as `Authorization: Bearer <token>` on subsequent
requests. Tokens are short-lived (15 min); rotate via
`POST /v1/portal/auth/refresh` with the refresh token.

---

## Browse inventory (no auth)

```bash
curl -sS "https://a2e-api.onrender.com/v1/public/listings?gpuTier=H100&tier=ON_DEMAND&limit=5"
```

Response shape:

```json
{
  "total": 14,
  "limit": 5,
  "offset": 0,
  "filters": { "gpuTier": "H100", "tier": "ON_DEMAND", ... },
  "listings": [
    {
      "operatorSlug": "seed-bronze-runner",
      "operatorName": "Seed Test Runner",
      "reputationTier": "BRONZE",
      "reputationScore": 26.7,
      "gpuTier": "H100",
      "region": "us-east-1",
      "availableCount": 1,
      "pricingTier": "ON_DEMAND",
      "ratePerHour": 5.8396,
      "ratePerMinute": 0.09733,
      "lastHeartbeat": "2026-05-12T15:56:00.085Z"
    }
  ]
}
```

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `gpuTier` | enum | (all) | H100, H200, B200, B300, GB300, OTHER |
| `region` | string | (all) | Exact match on the operator's region tag |
| `maxRatePerHour` | number | (none) | Ceiling in USD |
| `tier` | enum | ON_DEMAND | ON_DEMAND, SPOT (40% off), RESERVED (10% off) |
| `minReputation` | enum | (none) | BRONZE, SILVER, GOLD, PLATINUM |
| `limit` | int | 100 | 1-200 |
| `offset` | int | 0 | Pagination |

## Get the full catalog as JSON or CSV (no auth)

```bash
# JSON, attachable
curl -o listings.json https://a2e-api.onrender.com/v1/public/listings.json

# CSV, Excel-friendly
curl -o listings.csv https://a2e-api.onrender.com/v1/public/listings.csv
```

CSV columns:

```
operatorSlug,operatorName,reputationTier,reputationScore,gpuTier,region,availableCount,ratePerHourUsd,ratePerMinuteUsd,lastHeartbeat
```

Both feeds cache 60s at the edge.

## Get network stats (no auth)

```bash
curl -sS https://a2e-api.onrender.com/v1/public/stats
```

Returns nodes online by tier, total operators, lifetime rentals,
lifetime compute minutes, lifetime CO2 grams, region distribution, and
the reference retail price table. Cached 30s.

---

## Submit a compute request (auth required)

```bash
curl -X POST https://a2e-api.onrender.com/v1/buyer/compute/requests \
  -H "Authorization: Bearer $A2E_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "gpuTier": "H100",
    "gpuCount": 1,
    "tier": "ON_DEMAND",
    "durationDays": 1
  }'
```

Response: a `ComputeRequest` row in `PENDING` status with cost details.

**Tier flavors:**

- `ON_DEMAND` (default): full price, never preempted, no commitment
- `SPOT`: 40% off, preemptible with 90s notice, refund on unused
  minutes after preemption
- `RESERVED`: 10% off, requires `commitmentDays` (7, 30, or 90),
  exempt from preemption, early termination refunds only the minutes
  consumed

## Pay

Send the requested amount in USDC on Solana to the merchant wallet
shown on the request. The Helius webhook flips `txConfirmed=true`
within ~5 seconds.

## Poll for the SSH credential

Once `txConfirmed=true`, the auto-allocator picks an idle node within
its 10-second tick and mints an ephemeral SSH credential.

```bash
curl https://a2e-api.onrender.com/v1/buyer/compute/requests/$ID \
  -H "Authorization: Bearer $A2E_TOKEN"
```

When `status=ACTIVE` you get:

```json
{
  "status": "ACTIVE",
  "sshHost": "h100-42.a2e.network",
  "sshPort": 22,
  "sshUsername": "buyer-7b3f",
  "sshSessionToken": "eph-...",
  "sshSessionTokenExpiresAt": "...",
  "activatedAt": "...",
  "expiresAt": "...",
  "ratePerMinute": 0.09733,
  "co2Grams": 0
}
```

`sshSessionToken` is the password for SSH. It expires when the rental
ends.

## Run, terminate, refund

```bash
ssh buyer-7b3f@h100-42.a2e.network
# ... do work ...

# Stop early, get refund for unused minutes
curl -X POST https://a2e-api.onrender.com/v1/buyer/compute/requests/$ID/terminate \
  -H "Authorization: Bearer $A2E_TOKEN"
```

Refund settles via Solana within ~11 seconds median. Tx hash visible
in `/buyer/billing`.

## Active rentals (auth)

```bash
curl https://a2e-api.onrender.com/v1/buyer/compute/active \
  -H "Authorization: Bearer $A2E_TOKEN"
```

Returns the full list of your `ACTIVE` rentals with SSH, cost, and
carbon details.

## Billing (auth)

```bash
curl https://a2e-api.onrender.com/v1/buyer/billing \
  -H "Authorization: Bearer $A2E_TOKEN"
```

Returns `totalSpent`, `totalCo2Grams`, and a per-month breakdown of all
rentals.

---

## Errors

| Code | Meaning |
|---|---|
| 400 | Validation failure; message field has details |
| 401 | Token missing or expired |
| 403 | Wrong role (e.g. buyer endpoint hit with NODE_RUNNER token) |
| 404 | Resource not found or belongs to a different user |
| 409 | Conflict (e.g. wallet already in use, duplicate idempotency key) |
| 429 | Rate limit exceeded; wait and retry |
| 500 | Server error; report to support with the `requestId` in the response |

All error responses share the shape:

```json
{ "error": "Short Code", "message": "Human-readable detail" }
```

## Idempotency

`POST /v1/buyer/compute/requests` accepts an `Idempotency-Key` header
to make retries safe. Two layers:

1. **Header**: same key replays the cached response
2. **txHash dedup**: even without the header, a Solana payment tx hash
   is a one-shot event; the API rejects a second request with the
   same `txHash` from the same user

## Rate limits

Public routes: 100 requests / 60 seconds per IP (env-tunable). Buyer
auth routes are exempt.

## Versioning

The current path prefix `/v1/` is stable. Breaking changes will land
under a new prefix `/v2/` with overlap. The OpenAPI spec at
`/docs/json` is authoritative.

## Support

- Swagger UI: <https://a2e-api.onrender.com/docs>
- Issues: <https://github.com/StackMerth/a2e-neo-nodes/issues>
- Live chat (once enabled): bottom-right widget on the portal
