/**
 * Strava activity JSON → canonical archive fields.
 * Speeds on the wire are meters per second. Stored speeds are kilometers per hour.
 * Elevation fields are meters. This module does not read FIT, TCX, or GPX.
 */

import type { ArchiveIngest, NormalizedRecord } from "../../archive/model.js";

export const STRAVA_SOURCE = "strava";
export const STRAVA_API_ORIGIN = "https://www.strava.com/api/v3";

const BULKY_KEYS = [
  "map",
  "splits_metric",
  "splits_standard",
  "laps",
  "segment_efforts",
  "photos",
  "available_zones",
  "best_efforts",
  "highlighted_kudosers",
  "similar_activities",
];

export interface AdaptedStravaActivity {
  ingest: ArchiveIngest;
  normalized: NormalizedRecord;
}

/** Map one Strava activity summary (or detailed activity) onto a canonical row. */
export function adaptStravaActivity(activity: unknown, fallbackAthleteId?: string): AdaptedStravaActivity | null {
  const record = asRecord(activity);
  if (!record) return null;

  const entityId = idString(record.id);
  const athlete = asRecord(record.athlete);
  const userId = idString(athlete?.id) ?? (fallbackAthleteId ? idString(fallbackAthleteId) : null);
  if (!entityId || !userId) return null;

  const startedAt = readString(record, "start_date");
  const durationSec = readInteger(record.elapsed_time) ?? readInteger(record.moving_time);
  const endedAt = startedAt && durationSec !== null ? addSeconds(startedAt, durationSec) : null;
  const activityType = readString(record, "sport_type", "type");
  const distance = readNumber(record.distance);
  const calories = caloriesFrom(record);
  const avgHr = readInteger(record.average_heartrate);
  const maxHr = readInteger(record.max_heartrate);
  const avgSpeed = kmhFromMetersPerSecond(record.average_speed);
  const maxSpeed = kmhFromMetersPerSecond(record.max_speed);
  const minElevation = readNumber(record.elev_low);
  const maxElevation = readNumber(record.elev_high);
  const ascent = readNumber(record.total_elevation_gain);
  const descent = readNumber(record.total_elevation_loss);
  const title = readString(record, "name");
  const raw = JSON.stringify(record);

  const canonical = {
    source: STRAVA_SOURCE,
    event_kind: "exercise",
    source_user_id: userId,
    source_entity_id: entityId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_sec: durationSec,
    activity_type: activityType,
    distance,
    calories,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_speed: avgSpeed,
    max_speed: maxSpeed,
    min_elevation: minElevation,
    max_elevation: maxElevation,
    ascent,
    descent,
    title,
    extras: extrasFrom(record),
  };

  return {
    ingest: {
      source: STRAVA_SOURCE,
      sourceUserId: userId,
      sourceEntityId: entityId,
      eventKind: "exercise",
      occurredAt: startedAt,
      sourceUrl: `https://www.strava.com/activities/${entityId}`,
      rawEnvelope: raw,
      startedAt,
    },
    normalized: {
      startedAt,
      endedAt,
      durationSec,
      activityType,
      distance,
      calories,
      avgHr,
      maxHr,
      avgSpeed,
      maxSpeed,
      minElevation,
      maxElevation,
      ascent,
      descent,
      title,
      document: canonical,
      rawPayload: record,
      artifacts: [],
      bulkyKeys: BULKY_KEYS,
    },
  };
}

function caloriesFrom(record: Record<string, unknown>): number | null {
  const calories = readNumber(record.calories);
  if (calories !== null) return Math.round(calories);
  const kilojoules = readNumber(record.kilojoules);
  if (kilojoules === null) return null;
  return Math.round(kilojoules / 4.184);
}

/** Strava publishes speed in m/s. The archive stores km/h. */
function kmhFromMetersPerSecond(value: unknown): number | null {
  const metersPerSecond = readNumber(value);
  if (metersPerSecond === null) return null;
  return Math.round(metersPerSecond * 3.6 * 100) / 100;
}

function extrasFrom(record: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  copyScalar(extras, record, "moving_time");
  copyScalar(extras, record, "elapsed_time");
  copyScalar(extras, record, "kilojoules");
  copyScalar(extras, record, "commute");
  copyScalar(extras, record, "trainer");
  copyScalar(extras, record, "manual");
  copyScalar(extras, record, "gear_id");
  copyScalar(extras, record, "timezone");
  copyScalar(extras, record, "start_date_local");
  copyScalar(extras, record, "has_heartrate");
  return extras;
}

function copyScalar(target: Record<string, unknown>, record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
  }
}

function addSeconds(iso: string, seconds: number): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + seconds * 1000).toISOString();
}

function idString(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,32}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown): number | null {
  const number = readNumber(value);
  return number === null ? null : Math.round(number);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
