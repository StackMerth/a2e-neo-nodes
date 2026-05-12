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

### Seed keep-alive (test-only)

- Currently ENABLED via `SEED_KEEP_ALIVE_ENABLED=1`.
- **Must be disabled** before public launch so fake seed inventory
  stops competing with real node agents. Unset the env var and
  redeploy.

## 7. Payments / settlements

### Solana

- **Mode:** `PAYMENT_MODE` env (`dev` = devnet, `live` = mainnet).
- **Helius:** `HELIUS_API_KEY` env. Currently on free tier; upgrade to
  Developer ($49/mo) once active buyer count exceeds ~100 or
  rate-limit signals appear in logs.
- **Webhook URL** at Helius dashboard: `https://tokenosdeai-api.onrender.com/v1/webhooks/solana`

### Payer key

- Currently stored in plain text in `SettlementConfig.payerPrivateKey`.
  **Must be migrated** to env-sourced or encrypted-at-rest before
  flipping `PAYMENT_MODE=live`. See M1-#7 in the launch-blocker list.

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

## 10. Where to file new issues

- Code bugs: GitHub issues on `StackMerth/a2e-neo-nodes`
- Incidents (paging): wherever you have your alerting set up
- Feature requests: backlog in the plan file at
  `~/.claude/plans/binary-plotting-rocket.md`
