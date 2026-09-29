-- Databases that already applied the first draft of 0001 (table archived_events).
-- Fresh installs create `activities` in 0001. This file creates that table when
-- 0001 was recorded against the older draft, and drops archived_events.

CREATE TABLE IF NOT EXISTS activities (
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
  distance REAL,
  calories INTEGER,
  avg_hr INTEGER,
  max_hr INTEGER,
  avg_speed REAL,
  max_speed REAL,
  title TEXT,
  artifacts_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_user_id, event_kind, source_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_activities_user_kind_time
  ON activities (source, source_user_id, event_kind, started_at);

CREATE INDEX IF NOT EXISTS idx_activities_status
  ON activities (status, updated_at);

DROP TABLE IF EXISTS archived_events;
