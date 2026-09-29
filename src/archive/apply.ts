/**
 * Turn a provider fetch result into a canonical D1 update.
 */

import type { FetchNormalizedResult } from "../providers/types.js";
import type { ArchiveDb } from "./db.js";
import type { ArchiveIngest, NormalizedRecord } from "./model.js";
import { packStoredRecord } from "./pack.js";
import { markArchiveStatus, saveArchived, upsertPending } from "./repository.js";

export async function applyFetchResult(
  db: ArchiveDb,
  ingest: ArchiveIngest,
  result: FetchNormalizedResult
): Promise<"archived" | "failed"> {
  if (result.ok) {
    await saveArchived(
      db,
      ingest,
      packStoredRecord({
        normalized: result.normalized,
        rawEnvelopeChars: ingest.rawEnvelope.length,
      })
    );
    return "archived";
  }
  await markArchiveStatus(db, ingest, "failed", result.error, { terminal: result.terminal });
  return "failed";
}

/** Insert or replace one fully mapped activity. Used by backfill adapters. */
export async function archiveMapped(db: ArchiveDb, ingest: ArchiveIngest, normalized: NormalizedRecord): Promise<void> {
  await upsertPending(db, ingest);
  await saveArchived(
    db,
    ingest,
    packStoredRecord({
      normalized,
      rawEnvelopeChars: ingest.rawEnvelope.length,
    })
  );
}
