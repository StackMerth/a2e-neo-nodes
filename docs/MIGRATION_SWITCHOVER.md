# Migration Baseline Switchover

This is a **one-time operator action** required to flip the API
deploy from `prisma db push` to proper `prisma migrate deploy`.
After this is done once, every future deploy uses migrations
correctly and you stop worrying about schema drift.

## Why this is needed

The Phase 1 inherited migrations folder was incomplete (the first
migration only added AuditLog tables, the second referenced enums
that no migration ever created). To work around that, the
production deploy was using `prisma db push --accept-data-loss`
which syncs the schema directly without tracking history.

M1 ships a clean baseline migration (`0_init`) that captures the
entire current schema in one file. Once the live database knows
about this baseline, all future schema changes can ship as proper
incremental migrations.

## What was committed in M1.6

```
packages/database/prisma/migrations/
  0_init/
    migration.sql        <- 671 lines, full schema
  migration_lock.toml
```

The two old broken migrations (`20260404_add_audit_reconciliation`,
`20260424023121_m7_external_overflow`) were removed. They were never
fully applied to production anyway — the `db push` workaround
bypassed them.

`render.yaml` still uses `db push` for the API startCommand. That
stays as the active path until the switchover steps below are
complete.

## The switchover (10 minutes)

**Run these once on the live Render database. After this, the
follow-up commit can flip render.yaml to `migrate deploy` and the
deploy is a clean no-op.**

### Step 1: Open a Render shell on `a2e-api`

Render dashboard → a2e-api → Shell tab.

### Step 2: Reset the `_prisma_migrations` tracking table

The live DB has rows from the old broken migrations and from the
`db push` workaround. Clear them:

```bash
psql "$DATABASE_URL" -c 'DELETE FROM "_prisma_migrations";'
```

Expected output: `DELETE 1` or `DELETE 2` depending on how many
rows existed. The actual schema (Node, User, Job tables, all
enums) is untouched. Only the migration tracking metadata is
cleared.

### Step 3: Mark `0_init` as already applied

Tell Prisma: "the schema this migration would create already
exists, just record that the migration ran."

```bash
cd /opt/render/project/src/packages/database
DATABASE_URL="$DATABASE_URL" npx prisma migrate resolve --applied 0_init
```

Expected output:
```
Migration 0_init marked as applied.
```

### Step 4: Verify

Confirm the tracking table now has exactly one row:

```bash
psql "$DATABASE_URL" -c 'SELECT migration_name, finished_at FROM "_prisma_migrations";'
```

Expected output:
```
 migration_name | finished_at
----------------+----------------------------
 0_init         | 2026-MM-DD HH:MM:SS+00
(1 row)
```

### Step 5: Test that `migrate deploy` is a no-op

```bash
cd /opt/render/project/src/packages/database
DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy
```

Expected output:
```
2 migrations found in prisma/migrations
No pending migrations to apply.
```

If you see "No pending migrations to apply" — congrats, the
switchover is complete on the live DB.

### Step 6: Tell the operator (me) you've done it

I'll then push a follow-up commit that flips `render.yaml`'s
startCommand from `prisma db push` to `prisma migrate deploy`.
The next Render deploy after that runs `migrate deploy` cleanly
(no-op since 0_init is already applied), and from now on every
new schema change you push gets applied incrementally and
tracked.

## How to add new schema changes after the switchover

Locally:

```bash
# 1. Edit packages/database/prisma/schema.prisma
# 2. Generate a new migration with a descriptive name:
cd packages/database
npx prisma migrate dev --name add_template_table

# This creates packages/database/prisma/migrations/
#   <timestamp>_add_template_table/migration.sql
# 3. Review the generated SQL
# 4. Commit and push
```

On the next Render deploy, `prisma migrate deploy` finds the new
migration, applies it, records it. No manual intervention needed.

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| Step 2: `psql: command not found` | The Render shell environment doesn't have psql installed | Use the Prisma alternative: `cd /opt/render/project/src/packages/database && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file <(echo 'DELETE FROM "_prisma_migrations";') --schema ./prisma/schema.prisma` |
| Step 3 fails with "table already exists" | `_prisma_migrations` was not fully cleared in Step 2 | Re-run Step 2; check for any other migration entries with `psql` |
| Step 5 reports pending migrations | Step 3 didn't actually mark as applied | Re-run Step 3, then verify with Step 4 |
| Service won't start after the follow-up render.yaml change | `migrate deploy` is finding migrations in the folder that aren't in the DB. Probably means Step 3 / 4 wasn't completed before the deploy ran. | Re-do Step 3 from a Render shell, then trigger a manual deploy. |

## Rollback plan if anything goes wrong

The actual schema and data are untouched throughout. The
`_prisma_migrations` table is metadata only. Worst case:

1. Re-insert the old rows manually (you can pull them from a
   pre-cleanup snapshot via Render's daily Postgres backups).
2. Or revert `render.yaml` to use `db push` again. This is the
   current state and is fully working; the migration baseline
   work is purely an upgrade.

## Why we don't automate this in CI

Resolving migrations against a live DB is a one-time bootstrap
that should be intentional and witnessed. Automating it in a
deploy script is risky because:

1. Race conditions: multiple workers running the same script
   concurrently could double-apply.
2. Idempotency: `migrate resolve --applied` errors on second
   run, which would break re-deploys.
3. Visibility: the operator should see the output of the
   migration tracking reset to know it worked.

After this one-time switchover, every subsequent migration is
fully automatic via `prisma migrate deploy` on every deploy.
