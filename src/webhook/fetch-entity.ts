/**
 * Fetch the AccessLink entity a webhook points at, plus exercise exports.
 * Only https://www.polaraccesslink.com URLs are requested.
 */

import {
  exerciseExportUrls,
  packArchiveParts,
  resourceUrlFor,
  sanitizeErrorMessage,
  type ArchiveParts,
  type PackedArchive,
  type PolarNotification,
} from "./payload.js";

export interface FetchResult {
  status: "archived" | "failed";
  terminal: boolean;
  error: string | null;
  packed: PackedArchive | null;
}

interface HttpGet {
  ok: boolean;
  status: number;
  body: ArrayBuffer;
}

const FETCH_TIMEOUT_MS = 20_000;

export async function fetchEventArchive(
  notification: PolarNotification,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<FetchResult> {
  try {
    if (notification.event === "EXERCISE") {
      return await fetchExercise(notification, accessToken, fetchImpl);
    }
    return await fetchGeneric(notification, accessToken, fetchImpl);
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    return {
      status: "failed",
      terminal: isTerminalFetchError(message),
      error: message,
      packed: null,
    };
  }
}

async function fetchExercise(
  notification: PolarNotification,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<FetchResult> {
  const detailUrl = resourceUrlFor(notification);
  const exports = exerciseExportUrls(notification.entityId);
  const [detail, fit, tcx, gpx] = await Promise.all([
    httpGet(fetchImpl, detailUrl, accessToken, "application/json"),
    exports ? httpGet(fetchImpl, exports.fit, accessToken, "*/*") : Promise.resolve(null),
    exports ? httpGet(fetchImpl, exports.tcx, accessToken, "application/xml, */*") : Promise.resolve(null),
    exports ? httpGet(fetchImpl, exports.gpx, accessToken, "application/gpx+xml, */*") : Promise.resolve(null),
  ]);

  if (!detail.ok) {
    return httpFailure("exercise", detail.status);
  }

  const payload = decodeJsonBody(detail);
  const notes: Record<string, string> = {};
  const parts: ArchiveParts = {
    payload,
    fitBase64: encodeExport(fit, notes, "fit"),
    tcx: encodeTextExport(tcx, notes, "tcx"),
    gpx: encodeTextExport(gpx, notes, "gpx"),
    exportNotes: notes,
  };
  const packed = packArchiveParts(parts);
  return { status: "archived", terminal: false, error: null, packed };
}

async function fetchGeneric(
  notification: PolarNotification,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<FetchResult> {
  const url = resourceUrlFor(notification);
  const response = await httpGet(fetchImpl, url, accessToken, "application/json");
  if (!response.ok) {
    return httpFailure(notification.event, response.status);
  }
  const packed = packArchiveParts({
    payload: decodeJsonBody(response),
    fitBase64: null,
    tcx: null,
    gpx: null,
    exportNotes: {},
  });
  return { status: "archived", terminal: false, error: null, packed };
}

function isTerminalFetchError(message: string): boolean {
  return (
    message.startsWith("Refusing") ||
    message.startsWith("Invalid exercise") ||
    message.startsWith("Invalid resource") ||
    message.startsWith("No date") ||
    message.startsWith("Webhook payload has no")
  );
}

function httpFailure(label: string, status: number): FetchResult {
  const terminal = status === 400 || status === 401 || status === 403 || status === 404 || status === 410;
  return {
    status: "failed",
    terminal,
    error: `Polar API ${status} for ${label}`,
    packed: null,
  };
}

function decodeJsonBody(response: HttpGet): unknown {
  const text = new TextDecoder().decode(response.body).trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function encodeExport(response: HttpGet | null, notes: Record<string, string>, key: string): string | null {
  if (!response) return null;
  if (response.status === 404 || response.status === 204) {
    notes[key] = "unavailable";
    return null;
  }
  if (!response.ok) {
    notes[key] = `http_${response.status}`;
    return null;
  }
  if (response.body.byteLength === 0) {
    notes[key] = "unavailable";
    return null;
  }
  notes[key] = "stored";
  return bytesToBase64(new Uint8Array(response.body));
}

function encodeTextExport(response: HttpGet | null, notes: Record<string, string>, key: string): string | null {
  if (!response) return null;
  if (response.status === 404 || response.status === 204) {
    notes[key] = "unavailable";
    return null;
  }
  if (!response.ok) {
    notes[key] = `http_${response.status}`;
    return null;
  }
  const text = new TextDecoder().decode(response.body);
  if (!text.trim()) {
    notes[key] = "unavailable";
    return null;
  }
  notes[key] = "stored";
  return text;
}

async function httpGet(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  accept: string
): Promise<HttpGet> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.polaraccesslink.com") {
    throw new Error("Refusing resource URL outside Polar AccessLink");
  }
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: accept,
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Refusing redirect from Polar AccessLink");
  }
  const body = await response.arrayBuffer();
  return { ok: response.ok, status: response.status, body };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
