/**
 * Fit a normalized record into a single D1 row.
 * This module does not know provider field names. Callers pass bulkyKeys
 * for arrays that are safe to drop when the raw body is too large.
 */

import type { NormalizedRecord, PackedRecord } from "./model.js";

/** Stay under D1's 1 MiB row limit with room for the other columns. */
export const MAX_ROW_CHARS = 900_000;
export const MAX_PAYLOAD_CHARS = 700_000;
const MAX_SINGLE_ARTIFACT_CHARS = 800_000;

export function packStoredRecord(input: {
  normalized: NormalizedRecord;
  rawEnvelopeChars: number;
}): PackedRecord {
  const normalized = input.normalized;
  let rawStatus: PackedRecord["rawStatus"] = "complete";
  let rawValue = normalized.rawPayload;
  let raw = JSON.stringify(rawValue);
  if (raw.length > MAX_PAYLOAD_CHARS) {
    rawValue = stripKeys(rawValue, normalized.bulkyKeys);
    raw = JSON.stringify(rawValue);
    rawStatus = "trimmed";
  }

  const artifacts = normalized.artifacts.map((artifact) => ({ ...artifact }));
  for (const artifact of artifacts) {
    if (artifact.body && artifact.body.length > MAX_SINGLE_ARTIFACT_CHARS) {
      artifact.body = null;
      artifact.status = "too_large";
    }
  }

  const normalizedJson = JSON.stringify(normalized.document);
  const size = () =>
    raw.length +
    normalizedJson.length +
    input.rawEnvelopeChars +
    artifacts.reduce((sum, artifact) => sum + (artifact.body?.length ?? 0), 0);

  while (size() > MAX_ROW_CHARS) {
    const largest = artifacts
      .filter((artifact) => artifact.body)
      .sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0))[0];
    if (!largest) break;
    largest.body = null;
    largest.status = "omitted_row_limit";
  }

  if (size() > MAX_ROW_CHARS) {
    raw = JSON.stringify({ truncated: true });
    rawStatus = "truncated";
  }

  return {
    rawPayload: raw,
    rawStatus,
    normalized: normalizedJson,
    artifactsJson: JSON.stringify(artifacts),
    startedAt: normalized.startedAt,
    endedAt: normalized.endedAt,
    durationSec: normalized.durationSec,
    activityType: normalized.activityType,
    distance: normalized.distance,
    calories: normalized.calories,
    avgHr: normalized.avgHr,
    maxHr: normalized.maxHr,
    avgSpeed: normalized.avgSpeed,
    maxSpeed: normalized.maxSpeed,
    minElevation: normalized.minElevation,
    maxElevation: normalized.maxElevation,
    ascent: normalized.ascent,
    descent: normalized.descent,
    title: normalized.title,
  };
}

function stripKeys(value: unknown, keys: string[]): unknown {
  if (keys.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, keys));
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) continue;
    copy[key] = child;
  }
  return copy;
}
