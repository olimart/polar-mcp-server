/**
 * Polar webhook envelope parsing and AccessLink URL construction.
 * Produces an ArchiveIngest. Does not interpret exercise JSON fields.
 */

import type { ArchiveIngest } from "../../archive/model.js";
import { polarEventKind } from "./mapper.js";

export const DEFAULT_WORKER_ORIGIN = "https://polar-mcp-server.yafoy.workers.dev";
export const POLAR_SOURCE = "polar";

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

export interface ParsedPolarWebhook {
  providerEvent: string;
  ingest: ArchiveIngest;
}

export function webhookUrlFromOrigin(origin: string): string {
  return `${origin.replace(/\/$/, "")}/webhook`;
}

export function isSupportedWebhookEvent(event: string): event is SupportedWebhookEvent {
  return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

export function isPingEvent(body: unknown, headerEvent: string | null): boolean {
  const record = asRecord(body);
  const bodyEvent = record && typeof record.event === "string" ? record.event : null;
  if (headerEvent && bodyEvent && headerEvent !== bodyEvent) {
    return false;
  }
  return bodyEvent === "PING" || (headerEvent === "PING" && bodyEvent === null);
}

export function parsePolarWebhook(body: unknown, rawEnvelope: string): ParsedPolarWebhook | null {
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
    providerEvent: record.event,
    ingest: {
      source: POLAR_SOURCE,
      sourceUserId: userId,
      sourceEntityId: entityId,
      eventKind: polarEventKind(record.event),
      occurredAt: timestamp,
      sourceUrl: url,
      rawEnvelope,
      startedAt: date ? `${date}T00:00:00.000Z` : null,
    },
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

/** Fetch URL for an ingest. Exercise/activity/sleep/heart-rate use a canonical path, not the raw payload URL. */
export function resourceUrlFor(ingest: ArchiveIngest): string {
  switch (ingest.eventKind) {
    case "exercise":
      return exerciseDetailUrl(ingest.sourceEntityId);
    case "activity_summary":
      return datedOrPayloadUrl("/v3/users/activities/", ingest);
    case "sleep":
      return datedOrPayloadUrl("/v3/users/sleep/", ingest);
    case "continuous_heart_rate":
      return datedOrPayloadUrl("/v3/users/continuous-heart-rate/", ingest);
    default: {
      if (!ingest.sourceUrl) {
        throw new Error("Webhook payload has no resource URL");
      }
      return assertPolarResourceUrl(ingest.sourceUrl).toString();
    }
  }
}

export function exerciseExportUrls(entityId: string): { fit: string; tcx: string; gpx: string } | null {
  if (!ENTITY_ID.test(entityId)) return null;
  const base = `${POLAR_ACCESSLINK_ORIGIN}/v3/exercises/${entityId}`;
  return { fit: `${base}/fit`, tcx: `${base}/tcx`, gpx: `${base}/gpx` };
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

function datedOrPayloadUrl(path: string, ingest: ArchiveIngest): string {
  if (ISO_DATE.test(ingest.sourceEntityId)) {
    return `${POLAR_ACCESSLINK_ORIGIN}${path}${ingest.sourceEntityId}`;
  }
  if (!ingest.sourceUrl) {
    throw new Error("No date or resource URL");
  }
  return assertPolarResourceUrl(ingest.sourceUrl).toString();
}

function normalizeUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value)) return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
