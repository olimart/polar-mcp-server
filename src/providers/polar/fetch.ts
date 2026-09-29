/**
 * Download an AccessLink entity. Returns the provider body plus generic artifacts.
 * Only https://www.polaraccesslink.com is requested.
 */

import { sanitizeErrorMessage } from "../../archive/errors.js";
import type { ArchiveArtifact, ArchiveIngest } from "../../archive/model.js";
import { exerciseExportUrls, resourceUrlFor } from "./webhook.js";

export interface PolarFetched {
  ok: true;
  payload: unknown;
  artifacts: ArchiveArtifact[];
}

export interface PolarFetchFailure {
  ok: false;
  terminal: boolean;
  error: string;
}

const FETCH_TIMEOUT_MS = 20_000;

interface HttpGet {
  ok: boolean;
  status: number;
  body: ArrayBuffer;
}

export async function fetchPolarEntity(
  ingest: ArchiveIngest,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<PolarFetched | PolarFetchFailure> {
  try {
    if (ingest.eventKind === "exercise") {
      return await fetchExercise(ingest, accessToken, fetchImpl);
    }
    const response = await httpGet(fetchImpl, resourceUrlFor(ingest), accessToken, "application/json");
    if (!response.ok) return httpFailure(ingest.eventKind, response.status);
    return { ok: true, payload: decodeJsonBody(response), artifacts: [] };
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    return { ok: false, terminal: isTerminalFetchError(message), error: message };
  }
}

async function fetchExercise(
  ingest: ArchiveIngest,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<PolarFetched | PolarFetchFailure> {
  const detailUrl = resourceUrlFor(ingest);
  const exports = exerciseExportUrls(ingest.sourceEntityId);
  const [detail, fit, tcx, gpx] = await Promise.all([
    httpGet(fetchImpl, detailUrl, accessToken, "application/json"),
    exports ? httpGet(fetchImpl, exports.fit, accessToken, "*/*") : Promise.resolve(null),
    exports ? httpGet(fetchImpl, exports.tcx, accessToken, "application/xml, */*") : Promise.resolve(null),
    exports ? httpGet(fetchImpl, exports.gpx, accessToken, "application/gpx+xml, */*") : Promise.resolve(null),
  ]);

  if (!detail.ok) return httpFailure("exercise", detail.status);

  return {
    ok: true,
    payload: decodeJsonBody(detail),
    artifacts: [
      binaryArtifact("fit", fit),
      textArtifact("tcx", tcx),
      textArtifact("gpx", gpx),
    ].filter((artifact): artifact is ArchiveArtifact => artifact !== null),
  };
}

function binaryArtifact(kind: string, response: HttpGet | null): ArchiveArtifact | null {
  if (!response) return null;
  if (response.status === 404 || response.status === 204 || response.body.byteLength === 0) {
    return { kind, encoding: "base64", status: "unavailable", body: null };
  }
  if (!response.ok) {
    return { kind, encoding: "base64", status: `http_${response.status}`, body: null };
  }
  return { kind, encoding: "base64", status: "stored", body: bytesToBase64(new Uint8Array(response.body)) };
}

function textArtifact(kind: string, response: HttpGet | null): ArchiveArtifact | null {
  if (!response) return null;
  if (response.status === 404 || response.status === 204) {
    return { kind, encoding: "utf8", status: "unavailable", body: null };
  }
  if (!response.ok) {
    return { kind, encoding: "utf8", status: `http_${response.status}`, body: null };
  }
  const text = new TextDecoder().decode(response.body);
  if (!text.trim()) return { kind, encoding: "utf8", status: "unavailable", body: null };
  return { kind, encoding: "utf8", status: "stored", body: text };
}

function httpFailure(label: string, status: number): PolarFetchFailure {
  const terminal = status === 400 || status === 401 || status === 403 || status === 404 || status === 410;
  return { ok: false, terminal, error: `Polar API ${status} for ${label}` };
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

function decodeJsonBody(response: HttpGet): unknown {
  const text = new TextDecoder().decode(response.body).trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
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
