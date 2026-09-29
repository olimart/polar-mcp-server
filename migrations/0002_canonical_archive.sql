-- Canonical archive for databases that already applied the first draft of
-- 0001 (table archived_events, Polar-shaped columns). Fresh installs create
-- archived_records in 0001; this file is a no-op for that table and drops the
-- draft table if it is still present.

CREATE TABLE IF NOT EXISTS archived_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  occurred_at TEXT,
  source_url TEXT,
  raw_envelope TEXT NOT NULL,
  raw_payload TEXT,
  raw_status TEXT,
  normalized TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_sec INTEGER,
  activity_type TEXT,
  distance_m REAL,
  calories INTEGER,
  avg_hr INTEGER,
  max_hr INTEGER,
  title TEXT,
  artifacts_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_user_id, event_kind, source_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_records_user_kind_time
  ON archived_records (source, source_user_id, event_kind, started_at);

CREATE INDEX IF NOT EXISTS idx_archived_records_status
  ON archived_records (status, updated_at);

DROP TABLE IF EXISTS archived_events;
