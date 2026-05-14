-- Reduce the per-earning cool-down default from 48 hours to 12 hours.
-- The settlement engine uses a time-window approach driven by the
-- PAYOUT_COOLDOWN_HOURS env var (default also bumped to 12), so this
-- change to the column default mostly keeps the schema honest with
-- the actual policy — the engine never reads Earning.availableAt
-- for cool-down decisions, only for per-row admin overrides.
-- Existing rows keep whatever availableAt they were assigned.

ALTER TABLE "Earning"
    ALTER COLUMN "availableAt" SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '12 hours');
