/**
 * Retry incomplete archive rows. Rows are addressed by canonical keys.
 * The provider that matches `source` parses the stored envelope and fetches.
 */

import { applyFetchResult } from "../archive/apply.js";
import type { ArchiveDb } from "../archive/db.js";
import { sanitizeErrorMessage } from "../archive/errors.js";
import type { RetryCandidate } from "../archive/model.js";
import {
  keyFromCandidate,
  listRetryCandidates,
  listUserIncomplete,
  markArchiveStatus,
} from "../archive/repository.js";
import type { KvStore } from "../providers/kv.js";
import { providerForSource } from "../providers/registry.js";
import { POLAR_SOURCE } from "../providers/polar/webhook.js";

const RETRY_DELAY_MS = 2 * 60 * 1000;
const RETRY_BATCH = 25;

export async function retryIncompleteArchives(
  deps: { db: ArchiveDb | null; kv: KvStore; fetchImpl?: typeof fetch },
  options: { now?: Date; limit?: number } = {}
): Promise<{ retried: number; archived: number; failed: number }> {
  if (!deps.db) return { retried: 0, archived: 0, failed: 0 };
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - RETRY_DELAY_MS).toISOString();
  const rows = await listRetryCandidates(deps.db, olderThan, options.limit ?? RETRY_BATCH);
  return retryRows(deps.db, deps.kv, rows, deps.fetchImpl ?? fetch);
}

/** Re-fetch this Polar user's incomplete rows after they connect. Ignores the attempt cap. */
export async function retryUserArchives(
  deps: { db: ArchiveDb | null; kv: KvStore; fetchImpl?: typeof fetch },
  userId: string | number
): Promise<{ retried: number; archived: number; failed: number }> {
  if (!deps.db) return { retried: 0, archived: 0, failed: 0 };
  const rows = await listUserIncomplete(deps.db, POLAR_SOURCE, String(userId));
  return retryRows(deps.db, deps.kv, rows, deps.fetchImpl ?? fetch);
}

async function retryRows(
  db: ArchiveDb,
  kv: KvStore,
  rows: RetryCandidate[],
  fetchImpl: typeof fetch
): Promise<{ retried: number; archived: number; failed: number }> {
  let archived = 0;
  let failed = 0;
  for (const row of rows) {
    const key = keyFromCandidate(row);
    const provider = providerForSource(row.source);
    if (!provider) {
      await markArchiveStatus(db, key, "failed", `Unknown archive source ${row.source}`, { terminal: true });
      failed += 1;
      continue;
    }
    const ingest = provider.parseEnvelope(row.raw_envelope);
    if (!ingest) {
      await markArchiveStatus(db, key, "failed", "Stored webhook envelope could not be parsed", { terminal: true });
      failed += 1;
      continue;
    }
    const token = await provider.loadAccessToken(kv, ingest.sourceUserId);
    if (!token) {
      await markArchiveStatus(db, ingest, "missing_token", provider.missingTokenMessage());
      failed += 1;
      continue;
    }
    try {
      const result = await provider.fetchNormalized(ingest, token, fetchImpl);
      const outcome = await applyFetchResult(db, ingest, result);
      if (outcome === "archived") archived += 1;
      else failed += 1;
    } catch (error) {
      await markArchiveStatus(db, ingest, "failed", sanitizeErrorMessage(error));
      failed += 1;
    }
  }
  return { retried: rows.length, archived, failed };
}
