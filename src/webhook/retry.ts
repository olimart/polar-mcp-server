/**
 * Finish a stored webhook notification: load nothing from Polar until a token
 * exists, then fetch and update the D1 row.
 */

import {
  listRetryCandidates,
  listUserIncomplete,
  markArchiveStatus,
  saveArchived,
  type ArchiveDb,
} from "./archive.js";
import { fetchEventArchive } from "./fetch-entity.js";
import { parseWebhookNotification, sanitizeErrorMessage, type PolarNotification } from "./payload.js";
import { loadPolarToken, type KvStore } from "./token-store.js";

const RETRY_DELAY_MS = 2 * 60 * 1000;
const RETRY_BATCH = 25;

export async function enrichNotification(
  db: ArchiveDb,
  notification: PolarNotification,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<"archived" | "failed"> {
  const result = await fetchEventArchive(notification, accessToken, fetchImpl);
  if (result.status === "archived" && result.packed) {
    await saveArchived(db, {
      notification,
      payload: result.packed.payload,
      summary: result.packed.summary,
      fitBase64: result.packed.fitBase64,
      tcx: result.packed.tcx,
      gpx: result.packed.gpx,
      exportsJson: result.packed.exportsJson,
    });
    return "archived";
  }
  await markArchiveStatus(db, notification, "failed", result.error ?? "Fetch failed", {
    terminal: result.terminal,
  });
  return "failed";
}

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

export async function retryUserArchives(
  deps: { db: ArchiveDb | null; kv: KvStore; fetchImpl?: typeof fetch },
  userId: string | number
): Promise<{ retried: number; archived: number; failed: number }> {
  if (!deps.db) return { retried: 0, archived: 0, failed: 0 };
  const rows = await listUserIncomplete(deps.db, String(userId));
  return retryRows(deps.db, deps.kv, rows, deps.fetchImpl ?? fetch);
}

async function retryRows(
  db: ArchiveDb,
  kv: KvStore,
  rows: { webhook_payload: string }[],
  fetchImpl: typeof fetch
): Promise<{ retried: number; archived: number; failed: number }> {
  let archived = 0;
  let failed = 0;
  for (const row of rows) {
    let notification: PolarNotification | null = null;
    try {
      notification = parseWebhookNotification(JSON.parse(row.webhook_payload) as unknown);
    } catch {
      notification = null;
    }
    if (!notification) {
      failed += 1;
      continue;
    }
    const token = await loadPolarToken(kv, notification.userId);
    if (!token) {
      await markArchiveStatus(
        db,
        notification,
        "missing_token",
        "No stored Polar access token for this user. Reconnect the app so future sessions can be archived."
      );
      failed += 1;
      continue;
    }
    try {
      const outcome = await enrichNotification(db, notification, token, fetchImpl);
      if (outcome === "archived") archived += 1;
      else failed += 1;
    } catch (error) {
      await markArchiveStatus(db, notification, "failed", sanitizeErrorMessage(error));
      failed += 1;
    }
  }
  return { retried: rows.length, archived, failed };
}
