/**
 * Polar archive provider: verify the webhook, fetch AccessLink, normalize.
 */

import { sanitizeErrorMessage } from "../../archive/errors.js";
import type { ArchiveIngest } from "../../archive/model.js";
import type { ArchiveProvider, FetchNormalizedResult, KvStore, WebhookDecision } from "../types.js";
import { fetchPolarEntity } from "./fetch.js";
import { mapPolarEntity } from "./mapper.js";
import { loadPolarToken } from "./tokens.js";
import { hasSignatureSecret, verifyPolarWebhookSignature } from "./signature.js";
import { isPingEvent, parsePolarWebhook } from "./webhook.js";

export const polarArchiveProvider: ArchiveProvider = {
  source: "polar",

  isUnsignedPing(body, headerEvent) {
    return isPingEvent(body, headerEvent);
  },

  async acceptWebhook(input): Promise<WebhookDecision> {
    if (!hasSignatureSecret(input.signatureSecret)) {
      return { type: "unauthorized" };
    }
    const valid = await verifyPolarWebhookSignature(
      input.rawBody,
      input.signatureHeader,
      input.signatureSecret.trim()
    );
    if (!valid) return { type: "unauthorized" };
    if (isPingEvent(input.body, input.headerEvent)) return { type: "ping" };
    const parsed = parsePolarWebhook(input.body, input.rawBody);
    if (!parsed) return { type: "bad_request" };
    if (input.headerEvent && input.headerEvent !== parsed.providerEvent) {
      return { type: "bad_request" };
    }
    return { type: "ingest", record: parsed.ingest };
  },

  loadAccessToken(kv: KvStore, sourceUserId: string) {
    return loadPolarToken(kv, sourceUserId);
  },

  async fetchNormalized(ingest, accessToken, fetchImpl): Promise<FetchNormalizedResult> {
    try {
      const fetched = await fetchPolarEntity(ingest, accessToken, fetchImpl);
      if (!fetched.ok) {
        return { ok: false, terminal: fetched.terminal, error: fetched.error };
      }
      return { ok: true, normalized: mapPolarEntity(ingest, fetched.payload, fetched.artifacts) };
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      return {
        ok: false,
        terminal: message.startsWith("Refusing") || message.startsWith("Invalid"),
        error: message,
      };
    }
  },

  parseEnvelope(rawEnvelope: string): ArchiveIngest | null {
    try {
      return parsePolarWebhook(JSON.parse(rawEnvelope) as unknown, rawEnvelope)?.ingest ?? null;
    } catch {
      return null;
    }
  },

  missingTokenMessage() {
    return "No stored Polar access token for this user. Reconnect the app so future sessions can be archived.";
  },
};
