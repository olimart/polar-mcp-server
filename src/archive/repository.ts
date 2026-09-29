/**
 * D1 repository. SQL in this file uses canonical columns only.
 */

import type { ArchiveDb } from "./db.js";
import type {
  ArchiveIngest,
  ArchiveKey,
  ArchiveDetail,
  ArchiveListItem,
  PackedRecord,
  RetryCandidate,
} from "./model.js";

export const MAX_ARCHIVE_ATTEMPTS = 8;

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export async function upsertPending(db: ArchiveDb, ingest: ArchiveIngest, now = new Date()): Promise<void> {
  const timestamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO archived_records (
         source, source_user_id, source_entity_id, event_kind,
         occurred_at, source_url, raw_envelope, started_at,
         status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT (source, source_user_id, event_kind, source_entity_id) DO UPDATE SET
         occurred_at = excluded.occurred_at,
         source_url = excluded.source_url,
         raw_envelope = excluded.raw_envelope,
         started_at = COALESCE(archived_records.started_at, excluded.started_at),
         status = 'pending',
         error = NULL,
         attempts = 0,
         updated_at = excluded.updated_at`
    )
    .bind(
      ingest.source,
      ingest.sourceUserId,
      ingest.sourceEntityId,
      ingest.eventKind,
      ingest.occurredAt,
      ingest.sourceUrl,
      ingest.rawEnvelope,
      ingest.startedAt,
      timestamp,
      timestamp
    )
    .run();
}

export async function saveArchived(
  db: ArchiveDb,
  key: ArchiveKey,
  packed: PackedRecord,
  now = new Date()
): Promise<void> {
  await db
    .prepare(
      `UPDATE archived_records SET
         raw_payload = ?,
         raw_status = ?,
         normalized = ?,
         started_at = ?,
         ended_at = ?,
         duration_sec = ?,
         activity_type = ?,
         distance_m = ?,
         calories = ?,
         avg_hr = ?,
         max_hr = ?,
         title = ?,
         artifacts_json = ?,
         status = 'archived',
         error = NULL,
         attempts = 0,
         updated_at = ?
       WHERE source = ? AND source_user_id = ? AND event_kind = ? AND source_entity_id = ?`
    )
    .bind(
      packed.rawPayload,
      packed.rawStatus,
      packed.normalized,
      packed.startedAt,
      packed.endedAt,
      packed.durationSec,
      packed.activityType,
      packed.distanceM,
      packed.calories,
      packed.avgHr,
      packed.maxHr,
      packed.title,
      packed.artifactsJson,
      nowIso(now),
      key.source,
      key.sourceUserId,
      key.eventKind,
      key.sourceEntityId
    )
    .run();
}

export async function markArchiveStatus(
  db: ArchiveDb,
  key: ArchiveKey,
  status: "failed" | "missing_token",
  error: string,
  options: { terminal?: boolean } = {},
  now = new Date()
): Promise<void> {
  if (status === "missing_token") {
    await db
      .prepare(
        `UPDATE archived_records SET
           status = 'missing_token',
           error = ?,
           updated_at = ?
         WHERE source = ? AND source_user_id = ? AND event_kind = ? AND source_entity_id = ?
           AND status != 'missing_token'`
      )
      .bind(error, nowIso(now), key.source, key.sourceUserId, key.eventKind, key.sourceEntityId)
      .run();
    return;
  }

  if (options.terminal) {
    await db
      .prepare(
        `UPDATE archived_records SET
           status = 'failed',
           error = ?,
           attempts = ?,
           updated_at = ?
         WHERE source = ? AND source_user_id = ? AND event_kind = ? AND source_entity_id = ?`
      )
      .bind(
        error,
        MAX_ARCHIVE_ATTEMPTS,
        nowIso(now),
        key.source,
        key.sourceUserId,
        key.eventKind,
        key.sourceEntityId
      )
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE archived_records SET
         status = 'failed',
         error = ?,
         attempts = attempts + 1,
         updated_at = ?
       WHERE source = ? AND source_user_id = ? AND event_kind = ? AND source_entity_id = ?`
    )
    .bind(error, nowIso(now), key.source, key.sourceUserId, key.eventKind, key.sourceEntityId)
    .run();
}

export function clampLimit(limit: number | undefined, fallback = 20): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

export function endBound(to: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59` : to;
}

export async function listArchivedRecords(
  db: ArchiveDb,
  query: { source: string; sourceUserId: string; eventKind?: string; from?: string; to?: string; limit?: number }
): Promise<ArchiveListItem[]> {
  const clauses = ["source = ?", "source_user_id = ?"];
  const binds: unknown[] = [query.source, query.sourceUserId];
  if (query.eventKind) {
    clauses.push("event_kind = ?");
    binds.push(query.eventKind);
  }
  if (query.from) {
    clauses.push("COALESCE(started_at, occurred_at) >= ?");
    binds.push(query.from);
  }
  if (query.to) {
    clauses.push("COALESCE(started_at, occurred_at) <= ?");
    binds.push(endBound(query.to));
  }
  binds.push(clampLimit(query.limit));
  const result = await db
    .prepare(
      `SELECT id, source, source_user_id, source_entity_id, event_kind, occurred_at,
              started_at, ended_at, duration_sec, activity_type, distance_m, calories,
              avg_hr, max_hr, title, status, error, created_at
       FROM archived_records
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(started_at, occurred_at) DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all<ArchiveListItem>();
  return result.results ?? [];
}

export async function getArchivedRecord(
  db: ArchiveDb,
  query: { source: string; sourceUserId: string; eventKind: string; sourceEntityId: string }
): Promise<ArchiveDetail | null> {
  return db
    .prepare(
      `SELECT id, source, source_user_id, source_entity_id, event_kind, occurred_at, source_url,
              raw_payload, raw_status, normalized, started_at, ended_at, duration_sec,
              activity_type, distance_m, calories, avg_hr, max_hr, title, artifacts_json,
              status, error, attempts, created_at, updated_at
       FROM archived_records
       WHERE source = ? AND source_user_id = ? AND event_kind = ? AND source_entity_id = ?`
    )
    .bind(query.source, query.sourceUserId, query.eventKind, query.sourceEntityId)
    .first<ArchiveDetail>();
}

const RETRY_COLUMNS = `SELECT source, source_user_id, source_entity_id, event_kind, raw_envelope
       FROM archived_records`;

export async function listRetryCandidates(
  db: ArchiveDb,
  olderThanIso: string,
  limit: number
): Promise<RetryCandidate[]> {
  const result = await db
    .prepare(
      `${RETRY_COLUMNS}
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
         AND updated_at <= ?
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(MAX_ARCHIVE_ATTEMPTS, olderThanIso, limit)
    .all<RetryCandidate>();
  return result.results ?? [];
}

export async function listUserIncomplete(
  db: ArchiveDb,
  source: string,
  sourceUserId: string,
  limit = 50
): Promise<RetryCandidate[]> {
  const result = await db
    .prepare(
      `${RETRY_COLUMNS}
       WHERE source = ?
         AND source_user_id = ?
         AND status IN ('pending', 'failed', 'missing_token')
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(source, sourceUserId, limit)
    .all<RetryCandidate>();
  return result.results ?? [];
}

export function keyFromCandidate(row: RetryCandidate): ArchiveKey {
  return {
    source: row.source,
    sourceUserId: row.source_user_id,
    sourceEntityId: row.source_entity_id,
    eventKind: row.event_kind,
  };
}
