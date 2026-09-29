/**
 * Client-credentials calls for the one webhook Polar allows per AccessLink client.
 * Basic auth uses POLAR_CLIENT_ID / POLAR_CLIENT_SECRET. The signature secret
 * is returned only by create and must not be logged.
 */

import { POLAR_API_BASE, encodeBasicAuth } from "../polar-api.js";
import {
  DEFAULT_WEBHOOK_EVENTS,
  SUPPORTED_WEBHOOK_EVENTS,
  isSupportedWebhookEvent,
  type SupportedWebhookEvent,
} from "../providers/polar/webhook.js";

export interface WebhookRegistration {
  id?: string;
  events: string[];
  url?: string;
  active?: boolean;
  signatureSecret?: string;
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${encodeBasicAuth(clientId, clientSecret)}`;
}

export function parseWebhookEvents(value: string | undefined): SupportedWebhookEvent[] {
  if (!value || !value.trim()) return [...DEFAULT_WEBHOOK_EVENTS];
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [...DEFAULT_WEBHOOK_EVENTS];
  const events: SupportedWebhookEvent[] = [];
  for (const event of parts) {
    if (!isSupportedWebhookEvent(event)) {
      throw new Error(
        `Unsupported webhook event "${event}". Supported: ${SUPPORTED_WEBHOOK_EVENTS.join(", ")}.`
      );
    }
    events.push(event);
  }
  return events;
}

export function readWebhookRegistration(body: unknown): WebhookRegistration | null {
  const record = asRecord(body);
  if (!record) return null;
  const data = record.data;
  const item = Array.isArray(data) ? data[0] : data;
  const source = asRecord(item) ?? record;
  if (!source.id && !source.url && !source.events && !source.signature_secret_key) {
    return null;
  }
  const events = Array.isArray(source.events) ? source.events.filter((event) => typeof event === "string") : [];
  return {
    id: typeof source.id === "string" ? source.id : undefined,
    events,
    url: typeof source.url === "string" ? source.url : undefined,
    active: typeof source.active === "boolean" ? source.active : undefined,
    signatureSecret: typeof source.signature_secret_key === "string" ? source.signature_secret_key : undefined,
  };
}

/** Drop the signature secret before anything is returned to an MCP client. */
export function publicWebhookRegistration(registration: WebhookRegistration | null): Record<string, unknown> | null {
  if (!registration) return null;
  return {
    id: registration.id ?? null,
    events: registration.events,
    url: registration.url ?? null,
    active: registration.active ?? null,
  };
}

export async function polarClientRequest(
  path: string,
  clientId: string,
  clientSecret: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(`${POLAR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text.slice(0, 300) };
    }
  }
  return { status: response.status, body };
}

export async function getWebhookRegistration(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<WebhookRegistration | null> {
  const result = await polarClientRequest("/webhooks", clientId, clientSecret, { method: "GET" }, fetchImpl);
  if (result.status === 204 || result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(`Polar webhook lookup failed (${result.status})`);
  }
  return readWebhookRegistration(result.body);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
