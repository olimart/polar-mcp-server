/**
 * A source adapter verifies webhooks, fetches the provider entity, and
 * returns a NormalizedRecord. It does not write to D1.
 */

import type { ArchiveIngest, NormalizedRecord } from "../archive/model.js";
import type { KvStore } from "./kv.js";

export type { KvStore };

export type WebhookDecision =
  | { type: "ping" }
  | { type: "unauthorized" }
  | { type: "bad_request" }
  | { type: "ingest"; record: ArchiveIngest };

export type FetchNormalizedResult =
  | { ok: true; normalized: NormalizedRecord }
  | { ok: false; terminal: boolean; error: string };

export interface ArchiveProvider {
  readonly source: string;
  isUnsignedPing(body: unknown, headerEvent: string | null): boolean;
  acceptWebhook(input: {
    rawBody: string;
    body: unknown;
    headerEvent: string | null;
    signatureHeader: string | null;
    signatureSecret: string;
  }): Promise<WebhookDecision>;
  loadAccessToken(kv: KvStore, sourceUserId: string): Promise<string | null>;
  fetchNormalized(
    ingest: ArchiveIngest,
    accessToken: string,
    fetchImpl: typeof fetch
  ): Promise<FetchNormalizedResult>;
  parseEnvelope(rawEnvelope: string): ArchiveIngest | null;
  missingTokenMessage(): string;
}
