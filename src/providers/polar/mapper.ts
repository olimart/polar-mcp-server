/**
 * Polar AccessLink JSON → canonical archive fields.
 * Add new Polar keys here. Do not add them as D1 columns.
 */

import type { ArchiveArtifact, ArchiveIngest, NormalizedRecord } from "../../archive/model.js";

/** AccessLink webhookType → canonical event_kind. Unknown names are lowercased. */
export const POLAR_EVENT_KINDS: Record<string, string> = {
  EXERCISE: "exercise",
  SLEEP: "sleep",
  CONTINUOUS_HEART_RATE: "continuous_heart_rate",
  SLEEP_WISE_CIRCADIAN_BEDTIME: "sleep_wise_circadian_bedtime",
  SLEEP_WISE_ALERTNESS: "sleep_wise_alertness",
  ACTIVITY_SUMMARY: "activity_summary",
  PHYSICAL_INFORMATION: "physical_information",
};

export function polarEventKind(providerEvent: string): string {
  return POLAR_EVENT_KINDS[providerEvent] ?? providerEvent.trim().toLowerCase();
}

/** Accept either a canonical kind or a Polar webhookType from tool arguments. */
export function canonicalEventKind(input: string): string {
  const trimmed = input.trim();
  if (POLAR_EVENT_KINDS[trimmed]) return POLAR_EVENT_KINDS[trimmed];
  return trimmed.toLowerCase();
}

export function mapPolarEntity(
  ingest: ArchiveIngest,
  payload: unknown,
  artifacts: ArchiveArtifact[]
): NormalizedRecord {
  const record = unwrapRecord(payload);
  const activityType = activityTypeFrom(record);
  const heart = record ? asRecord(record.heart_rate) ?? asRecord(record["heart-rate"]) : null;
  const durationSec = parseIso8601DurationSeconds(record ? readString(record, "duration") : null);
  const startedAt = startedAtFrom(record, ingest);
  const endedAt = startedAt && durationSec !== null ? addSeconds(startedAt, durationSec) : null;
  const distance = record ? readNumber(record.distance) : null;
  const calories = record ? readInteger(record.calories) : null;
  const avgHr = heart && typeof heart.average === "number" ? Math.round(heart.average) : null;
  const maxHr = heart && typeof heart.maximum === "number" ? Math.round(heart.maximum) : null;
  const speed = speedFrom(record);
  const title = record ? readString(record, "title", "name") : null;
  const extras = extrasFrom(record);

  const canonical = {
    source: ingest.source,
    event_kind: ingest.eventKind,
    source_user_id: ingest.sourceUserId,
    source_entity_id: ingest.sourceEntityId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_sec: durationSec,
    activity_type: activityType,
    distance,
    calories,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_speed: speed.avg,
    max_speed: speed.max,
    title,
    extras,
  };

  return {
    startedAt,
    endedAt,
    durationSec,
    activityType,
    distance,
    calories,
    avgHr,
    maxHr,
    avgSpeed: speed.avg,
    maxSpeed: speed.max,
    title,
    document: canonical,
    rawPayload: payload,
    artifacts,
    bulkyKeys: ["samples", "route"],
  };
}

export function parseIso8601DurationSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (![days, hours, minutes, seconds].every((part) => Number.isFinite(part))) return null;
  return Math.round(days * 86400 + hours * 3600 + minutes * 60 + seconds);
}

function startedAtFrom(record: Record<string, unknown> | null, ingest: ArchiveIngest): string | null {
  if (record) {
    const local = readString(record, "start_time", "start-time");
    if (local) {
      if (hasZone(local)) return local;
      const offset = readNumber(record.start_time_utc_offset ?? record["start-time-utc-offset"]);
      if (offset !== null) {
        const utc = localClockToUtc(local, offset);
        if (utc) return utc;
      }
      return local;
    }
    const date = readString(record, "date");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00.000Z`;
  }
  return ingest.startedAt;
}

/**
 * AccessLink has no average/max speed fields on the exercise summary.
 * Speed is sample type 1, in km/h, when samples were requested.
 * A speed.average / speed.maximum object is used when a provider sends one.
 */
function speedFrom(record: Record<string, unknown> | null): { avg: number | null; max: number | null } {
  if (!record) return { avg: null, max: null };
  const summary = asRecord(record.speed);
  const fromSamples = speedFromSamples(record.samples);
  const avg = readNumber(summary?.average ?? summary?.avg ?? record.avg_speed ?? record.average_speed ?? record["average-speed"]);
  const max = readNumber(summary?.maximum ?? summary?.max ?? record.max_speed ?? record.maximum_speed ?? record["maximum-speed"]);
  return {
    avg: roundSpeed(avg ?? fromSamples.avg),
    max: roundSpeed(max ?? fromSamples.max),
  };
}

function speedFromSamples(samples: unknown): { avg: number | null; max: number | null } {
  if (!Array.isArray(samples)) return { avg: null, max: null };
  const values: number[] = [];
  for (const sample of samples) {
    const row = asRecord(sample);
    if (!row || !isSpeedSample(row["sample-type"] ?? row.sample_type)) continue;
    values.push(...parseSampleSeries(row.data));
  }
  if (values.length === 0) return { avg: null, max: null };
  const sum = values.reduce((total, value) => total + value, 0);
  return { avg: sum / values.length, max: Math.max(...values) };
}

function isSpeedSample(sampleType: unknown): boolean {
  return sampleType === 1 || sampleType === "1";
}

function parseSampleSeries(data: unknown): number[] {
  const parts = Array.isArray(data)
    ? data
    : typeof data === "string"
      ? data.split(",")
      : [];
  const values: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") {
      if (Number.isFinite(part)) values.push(part);
      continue;
    }
    if (typeof part !== "string") continue;
    const token = part.trim();
    if (!token || token.toLowerCase() === "null") continue;
    const value = Number(token);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function roundSpeed(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function activityTypeFrom(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const detailed = readString(record, "detailed_sport_info", "detailed-sport-info");
  const sport = readString(record, "sport");
  if (detailed && detailed !== "UNKNOWN") return detailed;
  return sport;
}

function extrasFrom(record: Record<string, unknown> | null): Record<string, unknown> {
  if (!record) return {};
  const extras: Record<string, unknown> = {};
  copyScalar(extras, record, "device");
  copyScalar(extras, record, "upload_time", "upload-time");
  copyScalar(extras, record, "has_route", "has-route");
  copyScalar(extras, record, "training_load", "training-load");
  copyScalar(extras, record, "steps");
  copyScalar(extras, record, "active_steps", "active-steps");
  const date = readString(record, "date");
  if (date) extras.calendar_date = date;
  return extras;
}

function copyScalar(
  target: Record<string, unknown>,
  record: Record<string, unknown>,
  canonicalKey: string,
  providerKey = canonicalKey
): void {
  const value = record[providerKey] ?? record[canonicalKey];
  if (value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[canonicalKey] = value;
  }
}

function localClockToUtc(local: string, offsetMinutes: number): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const asUtc = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  if (Number.isNaN(asUtc)) return null;
  return new Date(asUtc - offsetMinutes * 60_000).toISOString();
}

function addSeconds(iso: string, seconds: number): string | null {
  if (hasZone(iso)) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + seconds * 1000).toISOString();
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "");
}

function hasZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function unwrapRecord(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return payload.length === 1 ? asRecord(payload[0]) : null;
  }
  return asRecord(payload);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
