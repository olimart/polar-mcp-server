-- Rename the archived_records draft (distance_m, no speed columns) to activities.
-- Fresh databases have no archived_records. A temporary empty table lets the
-- INSERT compile, then it is dropped. Existing draft rows are copied.

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

INSERT OR IGNORE INTO activities (
  id, source, source_user_id, source_entity_id, event_kind,
  occurred_at, source_url, raw_envelope, raw_payload, raw_status, normalized,
  started_at, ended_at, duration_sec, activity_type, distance, calories,
  avg_hr, max_hr, avg_speed, max_speed, title, artifacts_json,
  status, error, attempts, created_at, updated_at
)
SELECT
  id, source, source_user_id, source_entity_id, event_kind,
  occurred_at, source_url, raw_envelope, raw_payload, raw_status, normalized,
  started_at, ended_at, duration_sec, activity_type, distance_m, calories,
  avg_hr, max_hr, NULL, NULL, title, artifacts_json,
  status, error, attempts, created_at, updated_at
FROM archived_records;

DROP TABLE IF EXISTS archived_records;

CREATE INDEX IF NOT EXISTS idx_activities_user_kind_time
  ON activities (source, source_user_id, event_kind, started_at);

CREATE INDEX IF NOT EXISTS idx_activities_status
  ON activities (status, updated_at);

DROP INDEX IF EXISTS idx_archived_records_user_kind_time;
DROP INDEX IF EXISTS idx_archived_records_status;
