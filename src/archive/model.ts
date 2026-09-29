/**
 * Canonical archive model. D1 columns and this type use these names only.
 * Provider field names are translated before anything reaches the repository.
 * See ARCHITECTURE.md.
 */

export interface ArchiveKey {
  source: string;
  sourceUserId: string;
  sourceEntityId: string;
  eventKind: string;
}

/** Identity of one webhook delivery, before the provider entity is fetched. */
export interface ArchiveIngest extends ArchiveKey {
  occurredAt: string | null;
  sourceUrl: string | null;
  rawEnvelope: string;
  /** Best start time known from the envelope alone (for example a calendar day). */
  startedAt: string | null;
}

export interface ArchiveArtifact {
  kind: string;
  encoding: "utf8" | "base64";
  status: string;
  body: string | null;
}

/** Provider-neutral view of one archived entity. */
export interface NormalizedRecord {
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  activityType: string | null;
  /** Meters. */
  distance: number | null;
  calories: number | null;
  avgHr: number | null;
  maxHr: number | null;
  /** Kilometers per hour. */
  avgSpeed: number | null;
  /** Kilometers per hour. */
  maxSpeed: number | null;
  /** Altitude in meters, from the altitude series. */
  minElevation: number | null;
  maxElevation: number | null;
  /** Meters climbed and descended, summed from the altitude series. */
  ascent: number | null;
  descent: number | null;
  title: string | null;
  /** Self-contained canonical document stored in the normalized column. */
  document: Record<string, unknown>;
  /** Unmodified provider body. The packer may trim it to fit a row. */
  rawPayload: unknown;
  artifacts: ArchiveArtifact[];
  /** Property names the packer may drop when rawPayload is too large. */
  bulkyKeys: string[];
}

export interface PackedRecord {
  rawPayload: string | null;
  rawStatus: "complete" | "trimmed" | "truncated";
  normalized: string;
  artifactsJson: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  activityType: string | null;
  distance: number | null;
  calories: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  minElevation: number | null;
  maxElevation: number | null;
  ascent: number | null;
  descent: number | null;
  title: string | null;
}

export interface ArchiveListItem {
  id: number;
  source: string;
  source_user_id: string;
  source_entity_id: string;
  event_kind: string;
  occurred_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  activity_type: string | null;
  distance: number | null;
  calories: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  min_elevation: number | null;
  max_elevation: number | null;
  ascent: number | null;
  descent: number | null;
  title: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface ArchiveDetail extends ArchiveListItem {
  source_url: string | null;
  raw_payload: string | null;
  raw_status: string | null;
  normalized: string | null;
  artifacts_json: string | null;
  attempts: number;
  updated_at: string;
}

export interface RetryCandidate {
  source: string;
  source_user_id: string;
  source_entity_id: string;
  event_kind: string;
  raw_envelope: string;
}
