/**
 * Provider-neutral webhook receiver.
 *
 * The adapter verifies the signature and turns the body into an ArchiveIngest.
 * This module writes the pending row, then asks the adapter to fetch and
 * normalize. It does not read provider field names.
 */

import type { ArchiveProvider } from "../providers/types.js";
import type { KvStore } from "../providers/kv.js";
import { applyFetchResult } from "./apply.js";
import type { ArchiveDb } from "./db.js";
import { sanitizeErrorMessage } from "./errors.js";
import type { ArchiveIngest } from "./model.js";
import { markArchiveStatus, upsertPending } from "./repository.js";

export const WEBHOOK_FAILURE_LIMIT = 30;
export const WEBHOOK_FAILURE_WINDOW_SECONDS = 60;
export const MAX_WEBHOOK_BODY_CHARS = 65_536;

export interface WebhookRuntime {
  signatureSecret?: string;
  kv: KvStore;
  db: ArchiveDb | null;
  waitUntil(promise: Promise<unknown>): void;
  fetchImpl?: typeof fetch;
}

export async function handleProviderWebhook(
  provider: ArchiveProvider,
  request: Request,
  runtime: WebhookRuntime
): Promise<Response> {
  if (request.method !== "POST") {
    return text("method not allowed", 405);
  }

  const client = clientKey(request);
  if (await isRateLimited(runtime.kv, client)) {
    return text("too many requests", 429);
  }

  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY_CHARS) {
    return text("payload too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return text("bad request", 400);
  }

  const headerEvent = request.headers.get("Polar-Webhook-Event");
  const secret = hasSecret(runtime.signatureSecret) ? runtime.signatureSecret.trim() : "";

  if (!secret) {
    if (provider.isUnsignedPing(body, headerEvent)) {
      return text("ok", 200);
    }
    await recordFailure(runtime.kv, client);
    return text("unauthorized", 401);
  }

  const decision = await provider.acceptWebhook({
    rawBody: raw,
    body,
    headerEvent,
    signatureHeader: request.headers.get("Polar-Webhook-Signature"),
    signatureSecret: secret,
  });

  if (decision.type === "unauthorized") {
    await recordFailure(runtime.kv, client);
    return text("unauthorized", 401);
  }
  if (decision.type === "bad_request") {
    return text("bad request", 400);
  }
  if (decision.type === "ping") {
    return text("ok", 200);
  }

  return acceptIngest(provider, runtime, decision.record);
}

async function acceptIngest(
  provider: ArchiveProvider,
  runtime: WebhookRuntime,
  ingest: ArchiveIngest
): Promise<Response> {
  if (!runtime.db) {
    return text("archive unavailable", 503);
  }

  try {
    await upsertPending(runtime.db, ingest);
  } catch (error) {
    console.error("webhook persist failed", ingest.source, ingest.eventKind, sanitizeErrorMessage(error));
    return text("archive unavailable", 503);
  }

  const token = await provider.loadAccessToken(runtime.kv, ingest.sourceUserId);
  if (!token) {
    await markArchiveStatus(runtime.db, ingest, "missing_token", provider.missingTokenMessage());
    return text("ok", 200);
  }

  const db = runtime.db;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  runtime.waitUntil(enrichSafely(provider, db, ingest, token, fetchImpl));
  return text("ok", 200);
}

async function enrichSafely(
  provider: ArchiveProvider,
  db: ArchiveDb,
  ingest: ArchiveIngest,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  try {
    const result = await provider.fetchNormalized(ingest, accessToken, fetchImpl);
    await applyFetchResult(db, ingest, result);
  } catch (error) {
    console.error(
      "webhook enrich failed",
      ingest.source,
      ingest.eventKind,
      ingest.sourceEntityId,
      sanitizeErrorMessage(error)
    );
  }
}

function hasSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.trim().length > 0;
}

async function isRateLimited(kv: KvStore, client: string): Promise<boolean> {
  try {
    const current = Number((await kv.get(failureKey(client))) || "0");
    return Number.isFinite(current) && current >= WEBHOOK_FAILURE_LIMIT;
  } catch {
    return false;
  }
}

async function recordFailure(kv: KvStore, client: string): Promise<void> {
  try {
    const key = failureKey(client);
    const current = Number((await kv.get(key)) || "0");
    const next = Number.isFinite(current) ? current + 1 : 1;
    await kv.put(key, String(next), { expirationTtl: WEBHOOK_FAILURE_WINDOW_SECONDS });
  } catch {
    // Availability beats a perfect counter. Invalid signatures are still rejected.
  }
}

function failureKey(client: string): string {
  return `webhook_rl:${client}`;
}

function clientKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return ip.replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 64) || "local";
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
