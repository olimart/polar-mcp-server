-- Durable archive of Polar AccessLink webhook deliveries.
-- AccessLink only exposes data uploaded after the user registered with this
-- client, and exercises age out of the pull API after about 30 days.
-- This table is the long-term copy. OAuth tokens stay in OAUTH_KV.

CREATE TABLE IF NOT EXISTS archived_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  polar_user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event TEXT NOT NULL,
  event_timestamp TEXT,
  source_url TEXT,
  webhook_payload TEXT NOT NULL,
  payload TEXT,
  sport TEXT,
  start_time TEXT,
  duration TEXT,
  distance_m REAL,
  calories INTEGER,
  hr_avg INTEGER,
  fit_base64 TEXT,
  tcx TEXT,
  gpx TEXT,
  exports_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (polar_user_id, event, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_events_user_event_time
  ON archived_events (polar_user_id, event, start_time);

CREATE INDEX IF NOT EXISTS idx_archived_events_status
  ON archived_events (status, updated_at);
