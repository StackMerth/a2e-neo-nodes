-- Add optional deep-link path to Notification rows. Used by the
-- portal bell to navigate when a user clicks a notification. Nullable
-- so existing notifications continue to render without a click action.

ALTER TABLE "Notification" ADD COLUMN "link" TEXT;
