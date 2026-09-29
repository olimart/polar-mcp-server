/**
 * Polar webhook payload parsing, URL allowlisting, and D1 row packing.
 * Event-specific fetch URLs are derived here so new event types can be added
 * without changing the HTTP handler.
 */

export const DEFAULT_WORKER_ORIGIN = "https://polar-mcp-server.yafoy.workers.dev";

export const SUPPORTED_WEBHOOK_EVENTS = [
  "EXERCISE",
  "SLEEP",
  "CONTINUOUS_HEART_RATE",
  "SLEEP_WISE_CIRCADIAN_BEDTIME",
  "SLEEP_WISE_ALERTNESS",
  "ACTIVITY_SUMMARY",
  "PHYSICAL_INFORMATION",
] as const;

export type SupportedWebhookEvent = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

export const DEFAULT_WEBHOOK_EVENTS: SupportedWebhookEvent[] = ["EXERCISE", "ACTIVITY_SUMMARY"];

export const POLAR_ACCESSLINK_ORIGIN = "https://www.polaraccesslink.com";

const EVENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Stay under D1's 1 MiB row limit with room for the other columns. */
export const MAX_ROW_CHARS = 900_000;
export const MAX_PAYLOAD_CHARS = 700_000;
const MAX_SINGLE_EXPORT_CHARS = 800_000;

export interface PolarNotification {
  event: string;
  userId: string;
  entityId: string;
  timestamp: string | null;
  url: string | null;
  /** Activity/sleep/heart-rate day, when the payload has one. */
  date: string | null;
}

export function webhookUrlFromOrigin(origin: string): string {
  return `${origin.replace(/\/$/, "")}/webhook`;
}

export function isPingEvent(body: unknown, headerEvent: string | null): boolean {
  const record = asRecord(body);
  const bodyEvent = record && typeof record.event === "string" ? record.event : null;
  if (headerEvent && bodyEvent && headerEvent !== bodyEvent) {
    return false;
  }
  return bodyEvent === "PING" || (headerEvent === "PING" && bodyEvent === null);
}

export function parseWebhookNotification(body: unknown): PolarNotification | null {
  const record = asRecord(body);
  if (!record) return null;
  if (typeof record.event !== "string" || !EVENT_NAME.test(record.event) || record.event === "PING") {
    return null;
  }

  const userId = normalizeUserId(record.user_id);
  if (!userId) return null;

  const url = typeof record.url === "string" ? record.url : null;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const date = typeof record.date === "string" && ISO_DATE.test(record.date) ? record.date : null;
  const from = typeof record.from === "string" && ISO_DATE.test(record.from) ? record.from : null;
  const to = typeof record.to === "string" && ISO_DATE.test(record.to) ? record.to : null;

  let entityId: string | null = null;
  if (typeof record.entity_id === "string" && ENTITY_ID.test(record.entity_id)) {
    entityId = record.entity_id;
  } else if (date) {
    entityId = date;
  } else if (from && to) {
    entityId = `${from}_${to}`;
  } else if (timestamp && timestamp.length <= 64) {
    entityId = timestamp.replace(/[^A-Za-z0-9_.:+-]/g, "_");
  }

  if (!entityId) return null;

  return {
    event: record.event,
    userId,
    entityId,
    timestamp,
    url,
    date,
  };
}

export function assertPolarResourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid resource URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.polaraccesslink.com") {
    throw new Error("Refusing resource URL outside Polar AccessLink");
  }
  if (url.username || url.password) {
    throw new Error("Refusing resource URL with credentials");
  }
  if (!url.pathname.startsWith("/v3/") || url.pathname.includes("..")) {
    throw new Error("Refusing resource URL");
  }
  return url;
}

/**
 * URL to GET for a notification. EXERCISE/ACTIVITY/SLEEP/CHR use a canonical
 * AccessLink path built from the id, not the raw payload URL.
 */
export function resourceUrlFor(notification: PolarNotification): string {
  switch (notification.event) {
    case "EXERCISE":
      return exerciseDetailUrl(notification.entityId);
    case "ACTIVITY_SUMMARY":
      return datedOrPayloadUrl("/v3/users/activities/", notification);
    case "SLEEP":
      return datedOrPayloadUrl("/v3/users/sleep/", notification);
    case "CONTINUOUS_HEART_RATE":
      return datedOrPayloadUrl("/v3/users/continuous-heart-rate/", notification);
    default: {
      if (!notification.url) {
        throw new Error("Webhook payload has no resource URL");
      }
      return assertPolarResourceUrl(notification.url).toString();
    }
  }
}

export function exerciseExportUrls(entityId: string): { fit: string; tcx: string; gpx: string } | null {
  if (!ENTITY_ID.test(entityId)) return null;
  const base = `${POLAR_ACCESSLINK_ORIGIN}/v3/exercises/${entityId}`;
  return { fit: `${base}/fit`, tcx: `${base}/tcx`, gpx: `${base}/gpx` };
}

export interface ExerciseSummary {
  sport: string | null;
  startTime: string | null;
  duration: string | null;
  distanceM: number | null;
  calories: number | null;
  hrAvg: number | null;
}

export function extractExerciseSummary(payload: unknown): ExerciseSummary {
  const record = unwrapRecord(payload);
  if (!record) {
    return { sport: null, startTime: null, duration: null, distanceM: null, calories: null, hrAvg: null };
  }
  const detailed = readString(record, "detailed_sport_info", "detailed-sport-info");
  const sport = readString(record, "sport");
  const chosenSport = detailed && detailed !== "UNKNOWN" ? detailed : sport;
  const heart = asRecord(record.heart_rate) ?? asRecord(record["heart-rate"]);
  const average = heart && typeof heart.average === "number" ? heart.average : null;
  return {
    sport: chosenSport,
    startTime: readString(record, "start_time", "start-time"),
    duration: readString(record, "duration"),
    distanceM: readNumber(record.distance),
    calories: readInteger(record.calories),
    hrAvg: average === null ? null : Math.round(average),
  };
}

export interface ArchiveParts {
  payload: unknown;
  fitBase64: string | null;
  tcx: string | null;
  gpx: string | null;
  exportNotes: Record<string, string>;
}

export interface PackedArchive {
  payload: string;
  fitBase64: string | null;
  tcx: string | null;
  gpx: string | null;
  exportsJson: string;
  summary: ExerciseSummary;
}

export function packArchiveParts(parts: ArchiveParts): PackedArchive {
  const notes: Record<string, string> = { ...parts.exportNotes };
  let payloadValue = parts.payload;
  let payload = JSON.stringify(payloadValue);
  if (payload.length > MAX_PAYLOAD_CHARS) {
    payloadValue = stripBulky(payloadValue);
    payload = JSON.stringify(payloadValue);
    notes.samples = "omitted_size";
  } else if (!notes.samples) {
    notes.samples = "included";
  }

  let fitBase64 = capExport(parts.fitBase64, notes, "fit");
  let tcx = capExport(parts.tcx, notes, "tcx");
  let gpx = capExport(parts.gpx, notes, "gpx");

  const size = () => payload.length + lengthOf(fitBase64) + lengthOf(tcx) + lengthOf(gpx);
  if (size() > MAX_ROW_CHARS && fitBase64) {
    fitBase64 = null;
    notes.fit = "omitted_row_limit";
  }
  if (size() > MAX_ROW_CHARS && tcx) {
    tcx = null;
    notes.tcx = "omitted_row_limit";
  }
  if (size() > MAX_ROW_CHARS && gpx) {
    gpx = null;
    notes.gpx = "omitted_row_limit";
  }
  if (size() > MAX_ROW_CHARS) {
    const summary = extractExerciseSummary(parts.payload);
    payload = JSON.stringify({ truncated: true, ...summary });
    notes.payload = "summary_only";
  }

  return {
    payload,
    fitBase64,
    tcx,
    gpx,
    exportsJson: JSON.stringify(notes),
    summary: extractExerciseSummary(payloadValue),
  };
}

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/signature_secret_key["']?\s*[:=]\s*["'][^"']+["']/gi, "signature_secret_key=[redacted]")
    .replace(/accessToken["']?\s*[:=]\s*["'][^"']+["']/gi, "accessToken=[redacted]")
    .slice(0, 300);
}

export function isSupportedWebhookEvent(event: string): event is SupportedWebhookEvent {
  return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

function exerciseDetailUrl(entityId: string): string {
  if (!ENTITY_ID.test(entityId)) {
    throw new Error("Invalid exercise id");
  }
  const url = new URL(`${POLAR_ACCESSLINK_ORIGIN}/v3/exercises/${entityId}`);
  url.searchParams.set("samples", "true");
  url.searchParams.set("zones", "true");
  return url.toString();
}

function datedOrPayloadUrl(path: string, notification: PolarNotification): string {
  if (ISO_DATE.test(notification.entityId)) {
    return `${POLAR_ACCESSLINK_ORIGIN}${path}${notification.entityId}`;
  }
  if (!notification.url) {
    throw new Error("No date or resource URL");
  }
  return assertPolarResourceUrl(notification.url).toString();
}

function capExport(value: string | null, notes: Record<string, string>, key: string): string | null {
  if (!value) return null;
  if (value.length > MAX_SINGLE_EXPORT_CHARS) {
    notes[key] = "too_large";
    return null;
  }
  if (!notes[key]) notes[key] = "stored";
  return value;
}

function lengthOf(value: string | null): number {
  return value ? value.length : 0;
}

function stripBulky(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBulky);
  const record = asRecord(value);
  if (!record) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "samples" || key === "route") continue;
    copy[key] = child;
  }
  return copy;
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

function normalizeUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value)) return value;
  return null;
}
