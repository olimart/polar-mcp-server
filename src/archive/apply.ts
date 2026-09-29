/**
 * Turn a provider fetch result into a canonical D1 update.
 */

import type { FetchNormalizedResult } from "../providers/types.js";
import type { ArchiveDb } from "./db.js";
import type { ArchiveIngest } from "./model.js";
import { packStoredRecord } from "./pack.js";
import { markArchiveStatus, saveArchived } from "./repository.js";

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
