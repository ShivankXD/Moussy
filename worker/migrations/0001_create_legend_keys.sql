-- ════════════════════════════════════════════════════════════════════════════
--  0001 — Legend key inventory
--  One row per pre-generated Legend license key (format XXXXX-XXXXX-XXXXX).
--  This table is the single source of truth for what counts as a "valid" key.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS legend_keys (
  key         TEXT PRIMARY KEY,                 -- normalized (uppercase) key string
  redeemed    INTEGER NOT NULL DEFAULT 0,       -- 0 = false, 1 = true (SQLite has no BOOLEAN)
  redeemed_at TEXT,                             -- ISO-8601 timestamp, nullable
  device_id   TEXT                              -- binds a redeemed key to one install, nullable
);

-- Fast "who owns this key" lookups when a device re-checks.
CREATE INDEX IF NOT EXISTS idx_legend_keys_device ON legend_keys (device_id);
