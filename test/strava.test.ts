import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { archiveMapped } from "../src/archive/apply.js";
import type { ArchiveDb } from "../src/archive/db.js";
import { getArchivedRecord } from "../src/archive/repository.js";
import { listStravaActivities } from "../src/providers/strava/client.js";
import { adaptStravaActivity } from "../src/providers/strava/mapper.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Strava adapter", () => {
  it("maps a summary activity onto canonical columns", () => {
    const adapted = adaptStravaActivity({
      id: 9876543210,
      name: "Lunch Run",
      distance: 8123.4,
      moving_time: 2400,
      elapsed_time: 2700,
      total_elevation_gain: 86.2,
      elev_high: 142.5,
      elev_low: 98.1,
      type: "Run",
      sport_type: "TrailRun",
      start_date: "2024-06-01T10:15:00Z",
      start_date_local: "2024-06-01T12:15:00Z",
      timezone: "(GMT+02:00) Europe/Paris",
      average_speed: 3,
      max_speed: 4.5,
      average_heartrate: 148.4,
      max_heartrate: 172,
      kilojoules: 418.4,
      athlete: { id: 42 },
      commute: false,
      manual: false,
      map: { summary_polyline: "encoded" },
    });
    assert.ok(adapted);
    assert.equal(adapted.ingest.source, "strava");
    assert.equal(adapted.ingest.sourceUserId, "42");
    assert.equal(adapted.ingest.sourceEntityId, "9876543210");
    assert.equal(adapted.ingest.eventKind, "exercise");
    assert.equal(adapted.normalized.activityType, "TrailRun");
    assert.equal(adapted.normalized.distance, 8123.4);
    assert.equal(adapted.normalized.durationSec, 2700);
    assert.equal(adapted.normalized.startedAt, "2024-06-01T10:15:00Z");
    assert.equal(adapted.normalized.endedAt, "2024-06-01T11:00:00.000Z");
    assert.equal(adapted.normalized.avgHr, 148);
    assert.equal(adapted.normalized.maxHr, 172);
    assert.equal(adapted.normalized.avgSpeed, 10.8);
    assert.equal(adapted.normalized.maxSpeed, 16.2);
    assert.equal(adapted.normalized.minElevation, 98.1);
    assert.equal(adapted.normalized.maxElevation, 142.5);
    assert.equal(adapted.normalized.ascent, 86.2);
    assert.equal(adapted.normalized.descent, null);
    assert.equal(adapted.normalized.calories, 100);
    assert.equal(adapted.normalized.title, "Lunch Run");
    assert.equal(adapted.normalized.document.extras && (adapted.normalized.document.extras as { moving_time?: number }).moving_time, 2400);
    assert.equal(adapted.ingest.sourceUrl, "https://www.strava.com/activities/9876543210");
  });

  it("prefers calories over kilojoules and skips a row with no athlete", () => {
    const preferred = adaptStravaActivity({
      id: 7,
      athlete: { id: 1 },
      calories: 500,
      kilojoules: 10,
      start_date: "2024-01-01T00:00:00Z",
    });
    assert.equal(preferred?.normalized.calories, 500);
    assert.equal(adaptStravaActivity({ id: 7, name: "orphan" }), null);
    const fallback = adaptStravaActivity({ id: 8, name: "Named" }, "99");
    assert.equal(fallback?.ingest.sourceUserId, "99");
  });

  it("stores one row per Strava activity and updates it in place", async () => {
    const db = createTestDb();
    const first = adaptStravaActivity(sampleActivity("Morning"))!;
    const second = adaptStravaActivity(sampleActivity("Evening"))!;
    await archiveMapped(db, first.ingest, first.normalized);
    await archiveMapped(db, second.ingest, second.normalized);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM activities").bind().first<{ count: number }>();
    assert.equal(count?.count, 1);
    const row = await getArchivedRecord(db, {
      source: "strava",
      sourceUserId: "42",
      eventKind: "exercise",
      sourceEntityId: "55",
    });
    assert.equal(row?.status, "archived");
    assert.equal(row?.title, "Evening");
    assert.equal(row?.activity_type, "Ride");
    assert.equal(row?.distance, 20000);
    assert.equal(row?.avg_speed, 28.8);
    assert.equal(row?.ascent, 120);
    assert.match(row?.raw_payload || "", /Evening/);
    const listed = await db
      .prepare("SELECT raw_payload FROM activities WHERE source = 'strava'")
      .bind()
      .all<{ raw_payload: string }>();
    assert.equal(listed.results?.length, 1);
  });

  it("pages through the athlete activity list", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token-1");
      assert.equal(init?.redirect, "manual");
      const page = new URL(url).searchParams.get("page");
      const batch = page === "1" ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
      return Response.json(batch);
    };
    const activities = await listStravaActivities("token-1", fetchImpl, 2);
    assert.equal(activities.length, 3);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /per_page=2/);
  });
});

function sampleActivity(name: string) {
  return {
    id: 55,
    name,
    distance: 20000,
    elapsed_time: 3600,
    total_elevation_gain: 120,
    type: "Ride",
    sport_type: "Ride",
    start_date: "2023-05-01T08:00:00Z",
    average_speed: 8,
    max_speed: 12,
    athlete: { id: 42 },
  };
}

function createTestDb(): ArchiveDb {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(join(root, "migrations/0001_init_archive.sql"), "utf8"));
  return {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: Array<string | number | null | bigint> = [];
      const prepared = {
        bind(...values: unknown[]) {
          bound = values.map((value) => (value === undefined ? null : (value as string | number | null)));
          return prepared;
        },
        async run() {
          statement.run(...bound);
          return { success: true };
        },
        async first<T>() {
          const row = statement.get(...bound);
          return (row as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...bound) as T[] };
        },
      };
      return prepared;
    },
  };
}
