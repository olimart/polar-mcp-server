/**
 * POST /webhook
 *
 * Polar sends PING while creating the webhook, before signature_secret_key
 * exists. Unsigned PING is accepted only when the secret is not configured.
 * Every other request must carry a valid Polar-Webhook-Signature.
 *
 * The notification row is written before the response. The AccessLink fetch
 * continues on waitUntil so Polar gets a fast 200. Failures stay in D1 and
 * the scheduled retry picks them up.
 */

import { markArchiveStatus, upsertPending, type ArchiveDb } from "./archive.js";
import {
  isPingEvent,
  parseWebhookNotification,
  sanitizeErrorMessage,
  type PolarNotification,
} from "./payload.js";
import { enrichNotification } from "./retry.js";
import { hasSignatureSecret, verifyPolarWebhookSignature } from "./signature.js";
import { loadPolarToken, type KvStore } from "./token-store.js";

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

export async function handlePolarWebhook(request: Request, runtime: WebhookRuntime): Promise<Response> {
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
  const secret = hasSignatureSecret(runtime.signatureSecret) ? runtime.signatureSecret.trim() : "";

  if (!secret) {
    if (isPingEvent(body, headerEvent)) {
      return text("ok", 200);
    }
    await recordFailure(runtime.kv, client);
    return text("unauthorized", 401);
  }

  const valid = await verifyPolarWebhookSignature(
    raw,
    request.headers.get("Polar-Webhook-Signature"),
    secret
  );
  if (!valid) {
    await recordFailure(runtime.kv, client);
    return text("unauthorized", 401);
  }

  if (isPingEvent(body, headerEvent)) {
    return text("ok", 200);
  }

  const notification = parseWebhookNotification(body);
  if (!notification) {
    return text("bad request", 400);
  }
  if (headerEvent && headerEvent !== notification.event) {
    return text("bad request", 400);
  }

  if (!runtime.db) {
    return text("archive unavailable", 503);
  }

  try {
    await upsertPending(runtime.db, notification, raw);
  } catch (error) {
    console.error("webhook persist failed", notification.event, sanitizeErrorMessage(error));
    return text("archive unavailable", 503);
  }

  const token = await loadPolarToken(runtime.kv, notification.userId);
  if (!token) {
    await markArchiveStatus(
      runtime.db,
      notification,
      "missing_token",
      "No stored Polar access token for this user. Reconnect the app so future sessions can be archived."
    );
    return text("ok", 200);
  }

  runtime.waitUntil(enrichSafely(runtime, notification, token));
  return text("ok", 200);
}

async function enrichSafely(runtime: WebhookRuntime, notification: PolarNotification, accessToken: string): Promise<void> {
  if (!runtime.db) return;
  try {
    await enrichNotification(runtime.db, notification, accessToken, runtime.fetchImpl ?? fetch);
  } catch (error) {
    console.error("webhook enrich failed", notification.event, notification.entityId, sanitizeErrorMessage(error));
  }
}

export async function isRateLimited(kv: KvStore, client: string): Promise<boolean> {
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
