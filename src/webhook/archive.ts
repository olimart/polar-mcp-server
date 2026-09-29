/**
 * D1 persistence for archived Polar events.
 * The interface matches the subset of D1Database this worker uses so tests
 * can run the same SQL against node:sqlite.
 */

import type { ExerciseSummary, PolarNotification } from "./payload.js";

export const MAX_ARCHIVE_ATTEMPTS = 8;

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

export interface ArchiveDb {
  prepare(query: string): PreparedStatement;
}

export interface ArchivedEventListItem {
  id: number;
  entity_id: string;
  event: string;
  event_timestamp: string | null;
  sport: string | null;
  start_time: string | null;
  duration: string | null;
  distance_m: number | null;
  calories: number | null;
  hr_avg: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface ArchivedEventDetail extends ArchivedEventListItem {
  polar_user_id: string;
  source_url: string | null;
  payload: string | null;
  exports_json: string | null;
  attempts: number;
  updated_at: string;
  fit_base64?: string | null;
  tcx?: string | null;
  gpx?: string | null;
}

export interface RetryCandidate {
  polar_user_id: string;
  webhook_payload: string;
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export async function upsertPending(
  db: ArchiveDb,
  notification: PolarNotification,
  webhookPayload: string,
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO archived_events (
         polar_user_id, entity_id, event, event_timestamp, source_url,
         webhook_payload, start_time, status, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT (polar_user_id, event, entity_id) DO UPDATE SET
         event_timestamp = excluded.event_timestamp,
         source_url = excluded.source_url,
         webhook_payload = excluded.webhook_payload,
         start_time = COALESCE(excluded.start_time, archived_events.start_time),
         status = 'pending',
         error = NULL,
         attempts = 0,
         updated_at = excluded.updated_at`
    )
    .bind(
      notification.userId,
      notification.entityId,
      notification.event,
      notification.timestamp,
      notification.url,
      webhookPayload,
      notification.date,
      timestamp,
      timestamp
    )
    .run();
}

export interface SavedArchive {
  notification: PolarNotification;
  payload: string | null;
  summary: ExerciseSummary;
  fitBase64: string | null;
  tcx: string | null;
  gpx: string | null;
  exportsJson: string | null;
}

export async function saveArchived(db: ArchiveDb, saved: SavedArchive, now = new Date()): Promise<void> {
  const startTime = saved.summary.startTime ?? saved.notification.date;
  await db
    .prepare(
      `UPDATE archived_events SET
         payload = ?,
         sport = ?,
         start_time = ?,
         duration = ?,
         distance_m = ?,
         calories = ?,
         hr_avg = ?,
         fit_base64 = ?,
         tcx = ?,
         gpx = ?,
         exports_json = ?,
         status = 'archived',
         error = NULL,
         attempts = 0,
         updated_at = ?
       WHERE polar_user_id = ? AND event = ? AND entity_id = ?`
    )
    .bind(
      saved.payload,
      saved.summary.sport,
      startTime,
      saved.summary.duration,
      saved.summary.distanceM,
      saved.summary.calories,
      saved.summary.hrAvg,
      saved.fitBase64,
      saved.tcx,
      saved.gpx,
      saved.exportsJson,
      nowIso(now),
      saved.notification.userId,
      saved.notification.event,
      saved.notification.entityId
    )
    .run();
}

export async function markArchiveStatus(
  db: ArchiveDb,
  notification: PolarNotification,
  status: "failed" | "missing_token",
  error: string,
  options: { terminal?: boolean; bumpAttempt?: boolean } = {},
  now = new Date()
): Promise<void> {
  if (status === "missing_token") {
    await db
      .prepare(
        `UPDATE archived_events SET
           status = 'missing_token',
           error = ?,
           updated_at = ?
         WHERE polar_user_id = ? AND event = ? AND entity_id = ?
           AND status != 'missing_token'`
      )
      .bind(error, nowIso(now), notification.userId, notification.event, notification.entityId)
      .run();
    return;
  }

  if (options.terminal) {
    await db
      .prepare(
        `UPDATE archived_events SET
           status = 'failed',
           error = ?,
           attempts = ?,
           updated_at = ?
         WHERE polar_user_id = ? AND event = ? AND entity_id = ?`
      )
      .bind(
        error,
        MAX_ARCHIVE_ATTEMPTS,
        nowIso(now),
        notification.userId,
        notification.event,
        notification.entityId
      )
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE archived_events SET
         status = 'failed',
         error = ?,
         attempts = attempts + 1,
         updated_at = ?
       WHERE polar_user_id = ? AND event = ? AND entity_id = ?`
    )
    .bind(error, nowIso(now), notification.userId, notification.event, notification.entityId)
    .run();
}

export function clampLimit(limit: number | undefined, fallback = 20): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

export function endBound(to: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59` : to;
}

export async function listArchivedEvents(
  db: ArchiveDb,
  query: { userId: string; event?: string; from?: string; to?: string; limit?: number }
): Promise<ArchivedEventListItem[]> {
  const clauses = ["polar_user_id = ?"];
  const binds: unknown[] = [query.userId];
  if (query.event) {
    clauses.push("event = ?");
    binds.push(query.event);
  }
  if (query.from) {
    clauses.push("COALESCE(start_time, event_timestamp) >= ?");
    binds.push(query.from);
  }
  if (query.to) {
    clauses.push("COALESCE(start_time, event_timestamp) <= ?");
    binds.push(endBound(query.to));
  }
  binds.push(clampLimit(query.limit));
  const result = await db
    .prepare(
      `SELECT id, entity_id, event, event_timestamp, sport, start_time, duration,
              distance_m, calories, hr_avg, status, error, created_at
       FROM archived_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(start_time, event_timestamp) DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all<ArchivedEventListItem>();
  return result.results ?? [];
}

export async function getArchivedEvent(
  db: ArchiveDb,
  query: { userId: string; event: string; entityId: string; includeExports?: boolean }
): Promise<ArchivedEventDetail | null> {
  const exportColumns = query.includeExports ? ", fit_base64, tcx, gpx" : "";
  return db
    .prepare(
      `SELECT id, polar_user_id, entity_id, event, event_timestamp, source_url,
              payload, sport, start_time, duration, distance_m, calories, hr_avg,
              exports_json, status, error, attempts, created_at, updated_at
              ${exportColumns}
       FROM archived_events
       WHERE polar_user_id = ? AND event = ? AND entity_id = ?`
    )
    .bind(query.userId, query.event, query.entityId)
    .first<ArchivedEventDetail>();
}

export async function listRetryCandidates(
  db: ArchiveDb,
  olderThanIso: string,
  limit: number
): Promise<RetryCandidate[]> {
  const result = await db
    .prepare(
      `SELECT polar_user_id, webhook_payload
       FROM archived_events
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

export async function listUserIncomplete(db: ArchiveDb, userId: string, limit = 50): Promise<RetryCandidate[]> {
  const result = await db
    .prepare(
      `SELECT polar_user_id, webhook_payload
       FROM archived_events
       WHERE polar_user_id = ?
         AND status IN ('pending', 'failed', 'missing_token')
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<RetryCandidate>();
  return result.results ?? [];
}
