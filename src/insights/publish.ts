import type { ArchiveDb } from "../archive/db.js";
import { sanitizeErrorMessage } from "../archive/errors.js";
import { publishLoglyInsights } from "./logly.js";
import { addExercise, emptySportSummary, SPORT_PROJECT, sportInsights } from "./sports.js";
import { SPORT_TIME_ZONE, yearStartIso } from "./year.js";

export const LOGLY_BASE_URL = "https://logly.yafoy.com";

export interface SportInsightDeps {
  db: ArchiveDb | null;
  token?: string;
  baseUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export async function publishSportInsights(
  deps: SportInsightDeps
): Promise<{ published: number } | { skipped: string }> {
  if (!deps.db) return { skipped: "archive database is not configured" };
  const token = deps.token?.trim();
  if (!token) return { skipped: "LOGLY_TOKEN is not set" };

  const fromIso = yearStartIso(deps.now ?? new Date(), SPORT_TIME_ZONE);
  const summary = emptySportSummary();
  const rows = await listExercisesSince(deps.db, fromIso);
  for (const row of rows) addExercise(summary, row.activity_type, row.distance);
  const insights = sportInsights(summary, SPORT_PROJECT);
  await publishLoglyInsights(insights, {
    baseUrl: deps.baseUrl?.trim() || LOGLY_BASE_URL,
    token,
    projectName: SPORT_PROJECT,
    fetchImpl: deps.fetchImpl,
  });
  return { published: insights.length };
}

export function logSportInsightFailure(error: unknown): void {
  console.error("sport insights failed", sanitizeErrorMessage(error));
}

async function listExercisesSince(
  db: ArchiveDb,
  fromIso: string
): Promise<Array<{ activity_type: string | null; distance: number | null }>> {
  const result = await db
    .prepare(
      `SELECT activity_type, distance
       FROM activities
       WHERE event_kind = 'exercise'
         AND status = 'archived'
         AND COALESCE(started_at, occurred_at) >= ?`
    )
    .bind(fromIso)
    .all<{ activity_type: string | null; distance: number | null }>();
  return result.results ?? [];
}
