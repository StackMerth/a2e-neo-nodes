-- Pre-launch: split ExternalRental.lastError into two columns so
-- admins can distinguish real failures from clean lifecycle events
-- (termination reasons, allocator-race rollbacks, etc.).
--
-- lastError remains for actual failures (404s from provider GETs,
-- terminate-API errors, unexpected exceptions). lastNote captures
-- lifecycle messages that are NOT errors but worth persisting.
--
-- No data backfill needed — historical lastError values stay where
-- they are; new lifecycle events route to lastNote going forward.

ALTER TABLE "ExternalRental" ADD COLUMN "lastNote" TEXT;
