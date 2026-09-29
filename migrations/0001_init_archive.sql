-- Canonical archive. Column names are provider-neutral.
-- Polar (or a future source) is mapped into these fields before insert.
-- See ARCHITECTURE.md. OAuth tokens stay in OAUTH_KV.
--
-- distance, min_elevation, max_elevation, ascent, and descent are meters.
-- avg_speed and max_speed are km/h.

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
  min_elevation REAL,
  max_elevation REAL,
  ascent REAL,
  descent REAL,
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
