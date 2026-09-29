import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { ArchiveDb } from "../src/archive/db.js";
import { publishLoglyInsights } from "../src/insights/logly.js";
import { publishSportInsights } from "../src/insights/publish.js";
import {
  roundKilometers,
  sportForActivityType,
  sportInsights,
  emptySportSummary,
  addExercise,
} from "../src/insights/sports.js";
import { isSportInsightsCron, SPORT_INSIGHTS_CRON, yearStartIso } from "../src/insights/year.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("sport year", () => {
  it("starts at Toronto midnight on January 1, including across daylight saving", () => {
    assert.equal(yearStartIso(new Date("2026-09-29T16:00:00Z")), "2026-01-01T05:00:00.000Z");
    assert.equal(yearStartIso(new Date("2026-07-15T16:00:00Z")), "2026-01-01T05:00:00.000Z");
    assert.equal(yearStartIso(new Date("2026-01-01T05:00:00Z")), "2026-01-01T05:00:00.000Z");
    assert.equal(yearStartIso(new Date("2026-01-01T04:59:59Z")), "2025-01-01T05:00:00.000Z");
  });

  it("uses the daily cron registered in wrangler", () => {
    const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
    const matches = toml.match(/crons = \["\*\/15 \* \* \* \*", "0 7 \* \* \*"\]/g);
    assert.equal(matches?.length, 2);
    assert.equal(isSportInsightsCron(SPORT_INSIGHTS_CRON), true);
    assert.equal(isSportInsightsCron("*/15 * * * *"), false);
  });
});

describe("sport classification", () => {
  it("groups running, biking, and cross-country ski and ignores other sports", () => {
    assert.equal(sportForActivityType("Run"), "running");
    assert.equal(sportForActivityType("TrailRun"), "running");
    assert.equal(sportForActivityType("ROAD_RUNNING"), "running");
    assert.equal(sportForActivityType("Ride"), "biking");
    assert.equal(sportForActivityType("MountainBikeRide"), "biking");
    assert.equal(sportForActivityType("INDOOR_CYCLING"), "biking");
    assert.equal(sportForActivityType("NordicSki"), "cross-country-ski");
    assert.equal(sportForActivityType("CROSS-COUNTRY_SKIING"), "cross-country-ski");
    assert.equal(sportForActivityType("Swim"), "swimming");
    assert.equal(sportForActivityType("OPEN_WATER_SWIMMING"), "swimming");
    assert.equal(sportForActivityType("AlpineSki"), null);
    assert.equal(sportForActivityType("BackcountrySki"), null);
    assert.equal(sportForActivityType("Hike"), null);
    assert.equal(sportForActivityType(null), null);
  });

  it("sums distance, keeps the longest, and counts activities with no distance", () => {
    const summary = emptySportSummary();
    addExercise(summary, "Run", 5_000);
    addExercise(summary, "TrailRun", 12_000);
    addExercise(summary, "Run", null);
    addExercise(summary, "Ride", 40_000);
    addExercise(summary, "MountainBikeRide", 8_000);
    addExercise(summary, "NordicSki", 20_000);
    addExercise(summary, "NordicSki", 5_000);
    addExercise(summary, "Swim", 1_500);
    addExercise(summary, "OPEN_WATER_SWIMMING", 2_400);
    addExercise(summary, "Hike", 30_000);
    addExercise(summary, "AlpineSki", 9_000);

    assert.deepEqual(summary.running, { totalMeters: 17_000, longestMeters: 12_000, activities: 3 });
    assert.deepEqual(summary.biking, { totalMeters: 48_000, longestMeters: 40_000, activities: 2 });
    assert.deepEqual(summary["cross-country-ski"], { totalMeters: 25_000, longestMeters: 20_000, activities: 2 });
    assert.deepEqual(summary.swimming, { totalMeters: 3_900, longestMeters: 2_400, activities: 2 });
    assert.equal(roundKilometers(17_000), 17);
    assert.equal(roundKilometers(3_900), 3.9);
    assert.equal(roundKilometers(150), 0.2);
    assert.equal(roundKilometers(0), 0);

    const insights = sportInsights(summary);
    assert.equal(insights.length, 12);
    assert.deepEqual(insights[0], {
      project: "sport",
      title: "Running total distance",
      value: 17,
      icon: "🏃",
    });
    for (const insight of insights) {
      assert.equal(typeof insight.value, "number");
      if (insight.title.endsWith("activities")) assert.equal(Number.isInteger(insight.value), true);
      else assert.equal(insight.value, roundKilometers(insight.value * 1000));
    }
    assert.equal(insights[2]?.value, 3);
    assert.equal(insights[8]?.title, "Cross-country ski activities");
    assert.equal(insights[11]?.title, "Swimming activities");
  });
});

describe("logly publish", () => {
  it("posts the insight batch and creates the sport project when it is missing", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    let projectReady = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      calls.push({ url, body, authorization: headers.get("Authorization") });
      if (url.endsWith("/api/v1/projects")) {
        projectReady = true;
        return new Response(JSON.stringify({ slug: "sport" }), { status: 201 });
      }
      if (!projectReady) {
        return new Response(JSON.stringify({ error: "Project not found" }), { status: 404 });
      }
      return new Response("[]", { status: 200 });
    };

    await publishLoglyInsights(
      [{ project: "sport", title: "Running activities", value: 1, icon: "🏃" }],
      { baseUrl: "https://logly.yafoy.com/", token: "write-token", projectName: "sport", fetchImpl }
    );

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "https://logly.yafoy.com/api/v1/insight",
        "https://logly.yafoy.com/api/v1/projects",
        "https://logly.yafoy.com/api/v1/insight",
      ]
    );
    assert.equal(calls[0]?.authorization, "Bearer write-token");
    assert.deepEqual(calls[1]?.body, { name: "sport" });
  });

  it("publishes only archived exercises since Toronto new year", async () => {
    const db = createTestDb();
    await insertExercise(db, { id: "old", startedAt: "2025-12-31T23:00:00Z", activityType: "Run", distance: 99_000 });
    await insertExercise(db, { id: "edge", startedAt: "2026-01-01T04:59:59Z", activityType: "Run", distance: 1_000 });
    await insertExercise(db, { id: "run", startedAt: "2026-01-01T05:00:00.000Z", activityType: "Run", distance: 5_000 });
    await insertExercise(db, { id: "trail", startedAt: "2026-06-01T15:00:00Z", activityType: "TrailRun", distance: 12_000 });
    await insertExercise(db, { id: "nodist", startedAt: "2026-06-02T15:00:00Z", activityType: "Run", distance: null });
    await insertExercise(db, { id: "ride", startedAt: "2026-06-03T15:00:00Z", activityType: "Ride", distance: 40_000 });
    await insertExercise(db, { id: "mtb", startedAt: "2026-06-04T15:00:00Z", activityType: "MountainBikeRide", distance: 8_000 });
    await insertExercise(db, { id: "ski", startedAt: "2026-02-01T15:00:00Z", activityType: "NordicSki", distance: 20_000 });
    await insertExercise(db, { id: "swim", startedAt: "2026-07-01T15:00:00Z", activityType: "Swim", distance: 1_500 });
    await insertExercise(db, { id: "owswim", startedAt: "2026-07-02T15:00:00Z", activityType: "OPEN_WATER_SWIMMING", distance: 2_400 });
    await insertExercise(db, { id: "hike", startedAt: "2026-03-01T15:00:00Z", activityType: "Hike", distance: 30_000 });
    await insertExercise(db, {
      id: "pending",
      startedAt: "2026-04-01T15:00:00Z",
      activityType: "Run",
      distance: 50_000,
      status: "pending",
    });
    await insertExercise(db, {
      id: "summary",
      startedAt: "2026-04-02T15:00:00Z",
      activityType: "Run",
      distance: 50_000,
      eventKind: "activity_summary",
    });

    const posted: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response("[]", { status: 200 });
    };

    const result = await publishSportInsights({
      db,
      token: "write-token",
      now: new Date("2026-09-29T16:00:00Z"),
      fetchImpl,
    });

    assert.deepEqual(result, { published: 12 });
    const insights = (posted[0] as { insights: Array<{ title: string; value: string | number }> }).insights;
    const byTitle = Object.fromEntries(insights.map((insight) => [insight.title, insight.value]));
    assert.equal(byTitle["Running total distance"], 17);
    assert.equal(byTitle["Running longest distance"], 12);
    assert.equal(byTitle["Running activities"], 3);
    assert.equal(byTitle["Biking total distance"], 48);
    assert.equal(byTitle["Biking longest distance"], 40);
    assert.equal(byTitle["Biking activities"], 2);
    assert.equal(byTitle["Cross-country ski total distance"], 20);
    assert.equal(byTitle["Cross-country ski longest distance"], 20);
    assert.equal(byTitle["Cross-country ski activities"], 1);
    assert.equal(byTitle["Swimming total distance"], 3.9);
    assert.equal(byTitle["Swimming longest distance"], 2.4);
    assert.equal(byTitle["Swimming activities"], 2);
  });

  it("skips the publish when the write token is missing", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("[]", { status: 200 });
    };
    const result = await publishSportInsights({ db: createTestDb(), fetchImpl });
    assert.deepEqual(result, { skipped: "LOGLY_TOKEN is not set" });
    assert.equal(called, false);
  });
});

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

async function insertExercise(
  db: ArchiveDb,
  row: {
    id: string;
    startedAt: string;
    activityType: string;
    distance: number | null;
    status?: string;
    eventKind?: string;
  }
): void {
  const now = "2026-09-29T00:00:00.000Z";
  await db
    .prepare(
      `INSERT INTO activities (
         source, source_user_id, source_entity_id, event_kind, raw_envelope,
         started_at, activity_type, distance, status, attempts, created_at, updated_at
       ) VALUES ('strava', '10002900', ?, ?, '{}', ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(row.id, row.eventKind ?? "exercise", row.startedAt, row.activityType, row.distance, row.status ?? "archived", now, now)
    .run();
}
