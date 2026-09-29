/**
 * Copy Strava activity summaries into the canonical activities table.
 */

import { archiveMapped } from "../../archive/apply.js";
import type { ArchiveDb } from "../../archive/db.js";
import { adaptStravaActivity } from "./mapper.js";
import { fetchStravaAthlete, listStravaActivities } from "./client.js";

export interface StravaImportResult {
  athleteId: string;
  fetched: number;
  imported: number;
  skipped: number;
}

export async function importStravaActivities(
  db: ArchiveDb,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<StravaImportResult> {
  const athlete = await fetchStravaAthlete(accessToken, fetchImpl);
  const activities = await listStravaActivities(accessToken, fetchImpl);
  let imported = 0;
  let skipped = 0;
  for (const activity of activities) {
    const adapted = adaptStravaActivity(activity, athlete.id);
    if (!adapted) {
      skipped += 1;
      continue;
    }
    await archiveMapped(db, adapted.ingest, adapted.normalized);
    imported += 1;
  }
  return { athleteId: athlete.id, fetched: activities.length, imported, skipped };
}
