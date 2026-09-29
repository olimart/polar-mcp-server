import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { ArchiveDb } from "../src/archive/db.js";
import type { ArchiveArtifact, NormalizedRecord } from "../src/archive/model.js";
import { MAX_PAYLOAD_CHARS, packStoredRecord } from "../src/archive/pack.js";
import {
  getArchivedRecord,
  listArchivedRecords,
  listRetryCandidates,
  markArchiveStatus,
  upsertPending,
} from "../src/archive/repository.js";
import { handlePolarWebhook, WEBHOOK_FAILURE_LIMIT, type WebhookRuntime } from "../src/webhook/handle.js";
import { mapPolarEntity, parseIso8601DurationSeconds, polarEventKind } from "../src/providers/polar/mapper.js";
import { signPolarWebhookBody, verifyPolarWebhookSignature } from "../src/providers/polar/signature.js";
import { loadPolarToken, savePolarToken } from "../src/providers/polar/tokens.js";
import type { KvStore } from "../src/providers/kv.js";
import {
  assertPolarResourceUrl,
  isPingEvent,
  parsePolarWebhook,
  resourceUrlFor,
  webhookUrlFromOrigin,
} from "../src/providers/polar/webhook.js";
import {
  publicWebhookRegistration,
  readWebhookRegistration,
} from "../src/webhook/polar-webhook-api.js";
import { retryIncompleteArchives } from "../src/webhook/retry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("webhook signature", () => {
  it("matches node:crypto HMAC-SHA256 hex", async () => {
    const secret = "abe1f3ae-fd33-11e8-8eb2-f2801f1b9fd1";
    const body = JSON.stringify({ event: "PING", timestamp: "2019-01-11T08:25:10.02Z" });
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(await signPolarWebhookBody(body, secret), expected);
    assert.equal(await verifyPolarWebhookSignature(body, expected.toUpperCase(), secret), true);
    assert.equal(await verifyPolarWebhookSignature(body, `sha256=${expected}`, secret), true);
    assert.equal(await verifyPolarWebhookSignature(`${body} `, expected, secret), false);
    assert.equal(await verifyPolarWebhookSignature(body, expected, "other-secret"), false);
    assert.equal(await verifyPolarWebhookSignature(body, null, secret), false);
    assert.equal(await verifyPolarWebhookSignature(body, "abcd", secret), false);
  });
});

describe("webhook payloads", () => {
  it("parses exercise, activity, and sleepwise notifications", () => {
    const exerciseRaw = JSON.stringify({
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2018-05-15T14:22:24Z",
      url: "https://evil.example/not-used",
    });
    const exercise = parsePolarWebhook(JSON.parse(exerciseRaw), exerciseRaw);
    assert.equal(exercise?.ingest.sourceEntityId, "aQlC83");
    assert.equal(exercise?.ingest.sourceUserId, "475");
    assert.equal(exercise?.ingest.eventKind, "exercise");
    assert.equal(exercise?.ingest.source, "polar");
    assert.equal(
      resourceUrlFor(exercise!.ingest),
      "https://www.polaraccesslink.com/v3/exercises/aQlC83?samples=true&zones=true"
    );

    const activityRaw = JSON.stringify({
      event: "ACTIVITY_SUMMARY",
      user_id: "475",
      date: "2022-09-30",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
    });
    const activity = parsePolarWebhook(JSON.parse(activityRaw), activityRaw);
    assert.equal(activity?.ingest.sourceEntityId, "2022-09-30");
    assert.equal(activity?.ingest.eventKind, "activity_summary");
    assert.equal(resourceUrlFor(activity!.ingest), "https://www.polaraccesslink.com/v3/users/activities/2022-09-30");

    const alertnessRaw = JSON.stringify({
      event: "SLEEP_WISE_ALERTNESS",
      user_id: 475,
      from: "2022-09-30",
      to: "2022-10-02",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/sleepwise/alertness/date?from=2022-09-30&to=2022-10-02",
    });
    const alertness = parsePolarWebhook(JSON.parse(alertnessRaw), alertnessRaw);
    assert.equal(alertness?.ingest.sourceEntityId, "2022-09-30_2022-10-02");
    assert.equal(alertness?.ingest.eventKind, "sleep_wise_alertness");
    assert.equal(isPingEvent({ event: "PING", timestamp: "2018-05-15T14:22:24Z" }, "PING"), true);
    assert.equal(parsePolarWebhook({ event: "PING" }, "{\"event\":\"PING\"}"), null);
    assert.equal(parsePolarWebhook({ event: "EXERCISE", user_id: 1, entity_id: "../etc" }, "{}"), null);
  });

  it("refuses non-AccessLink URLs", () => {
    assert.throws(() => assertPolarResourceUrl("http://www.polaraccesslink.com/v3/exercises/1"), /Refusing/);
    assert.throws(() => assertPolarResourceUrl("https://evil.example/v3/exercises/1"), /Refusing/);
    assert.throws(() => assertPolarResourceUrl("https://www.polaraccesslink.com/v3/../secret"), /Refusing/);
    const allowed = assertPolarResourceUrl("https://www.polaraccesslink.com/v3/exercises/aQlC83");
    assert.equal(allowed.hostname, "www.polaraccesslink.com");
  });

  it("maps snake_case and kebab-case exercises onto canonical fields", () => {
    const ingest = {
      source: "polar",
      sourceUserId: "475",
      sourceEntityId: "aQlC83",
      eventKind: "exercise",
      occurredAt: null,
      sourceUrl: null,
      rawEnvelope: "{}",
      startedAt: null,
    };
    const mapped = mapPolarEntity(
      ingest,
      {
        sport: "OTHER",
        detailed_sport_info: "RUNNING",
        start_time: "2008-10-13T10:40:02",
        duration: "PT2H44M",
        distance: 1600,
        calories: 530,
        heart_rate: { average: 129.2, maximum: 147 },
      },
      []
    );
    assert.equal(mapped.activityType, "RUNNING");
    assert.equal(mapped.startedAt, "2008-10-13T10:40:02");
    assert.equal(mapped.durationSec, 9840);
    assert.equal(mapped.endedAt, "2008-10-13T13:24:02");
    assert.equal(mapped.distance, 1600);
    assert.equal(mapped.avgSpeed, null);
    assert.equal(mapped.maxSpeed, null);
    assert.equal(mapped.calories, 530);
    assert.equal(mapped.avgHr, 129);
    assert.equal(mapped.maxHr, 147);
    assert.equal(parseIso8601DurationSeconds("PT45M"), 2700);
    assert.equal(parseIso8601DurationSeconds("P"), null);
    assert.equal(polarEventKind("EXERCISE"), "exercise");

    const offset = mapPolarEntity(
      ingest,
      {
        sport: "OTHER",
        "detailed-sport-info": "CYCLING",
        "start-time": "2008-10-13T10:40:02",
        start_time_utc_offset: 180,
        duration: "PT2H44M",
        "heart-rate": { average: 100, maximum: 120 },
      },
      []
    );
    assert.equal(offset.activityType, "CYCLING");
    assert.equal(offset.avgHr, 100);
    assert.equal(offset.maxHr, 120);
    assert.equal(offset.startedAt, "2008-10-13T07:40:02.000Z");
    assert.equal(offset.endedAt, "2008-10-13T10:24:02.000Z");

    const withSamples = mapPolarEntity(
      ingest,
      {
        distance: 8000,
        samples: [
          { "sample-type": "0", data: "140,150" },
          { "sample-type": "1", data: "10,null,20,30" },
        ],
      },
      []
    );
    assert.equal(withSamples.avgSpeed, 20);
    assert.equal(withSamples.maxSpeed, 30);

    const summarized = mapPolarEntity(
      ingest,
      {
        speed: { average: 9.25, maximum: 15 },
        samples: [{ sample_type: 1, data: "1,2,3" }],
      },
      []
    );
    assert.equal(summarized.avgSpeed, 9.25);
    assert.equal(summarized.maxSpeed, 15);
  });

  it("drops artifacts that would exceed the D1 row budget", () => {
    const packed = packStoredRecord({
      normalized: normalizedFixture({
        activityType: "RUNNING",
        rawPayload: { sport: "RUNNING", note: "n".repeat(600_000) },
        artifacts: [{ kind: "fit", encoding: "base64", status: "stored", body: "A".repeat(400_000) }],
      }),
      rawEnvelopeChars: 100,
    });
    const artifacts = JSON.parse(packed.artifactsJson) as ArchiveArtifact[];
    assert.equal(artifacts[0]?.body, null);
    assert.equal(artifacts[0]?.status, "omitted_row_limit");
    assert.equal(packed.activityType, "RUNNING");
    assert.ok((packed.rawPayload?.length ?? 0) < MAX_PAYLOAD_CHARS);
    assert.equal(packed.rawStatus, "complete");
  });

  it("strips bulky samples before storing", () => {
    const packed = packStoredRecord({
      normalized: normalizedFixture({
        rawPayload: { sport: "RUNNING", samples: [{ data: "x".repeat(MAX_PAYLOAD_CHARS) }] },
        bulkyKeys: ["samples", "route"],
      }),
      rawEnvelopeChars: 0,
    });
    const stored = JSON.parse(packed.rawPayload || "{}") as { samples?: unknown; sport?: string };
    assert.equal(stored.samples, undefined);
    assert.equal(stored.sport, "RUNNING");
    assert.equal(packed.rawStatus, "trimmed");
  });

  it("builds the public webhook URL", () => {
    assert.equal(
      webhookUrlFromOrigin("https://polar-mcp-server.yafoy.workers.dev/"),
      "https://polar-mcp-server.yafoy.workers.dev/webhook"
    );
  });
});

describe("webhook registration parsing", () => {
  it("reads the create payload and strips the signature secret", () => {
    const registration = readWebhookRegistration({
      data: {
        id: "abdf33",
        events: ["EXERCISE", "ACTIVITY_SUMMARY"],
        url: "https://polar-mcp-server.yafoy.workers.dev/webhook",
        signature_secret_key: "abe1f3ae-fd33-11e8-8eb2-f2801f1b9fd1",
      },
    });
    assert.equal(registration?.signatureSecret, "abe1f3ae-fd33-11e8-8eb2-f2801f1b9fd1");
    const pub = publicWebhookRegistration(registration);
    assert.equal(JSON.stringify(pub).includes("abe1f3ae"), false);
    assert.equal(pub?.url, "https://polar-mcp-server.yafoy.workers.dev/webhook");

    const listed = readWebhookRegistration({
      data: [{ id: "abdf33", events: ["EXERCISE"], url: "https://example.com/webhook", active: true }],
    });
    assert.equal(listed?.active, true);
    assert.equal(listed?.signatureSecret, undefined);
  });
});

describe("archive database", () => {
  it("applies the migration and upserts one row per source, user, kind, and entity", async () => {
    const db = createTestDb();
    const columns = await db.prepare("PRAGMA table_info(activities)").bind().all<{ name: string }>();
    const names = (columns.results ?? []).map((column) => column.name);
    assert.ok(names.includes("source"));
    assert.ok(names.includes("raw_payload"));
    assert.ok(names.includes("normalized"));
    assert.ok(names.includes("distance"));
    assert.ok(names.includes("avg_speed"));
    assert.ok(names.includes("max_speed"));
    assert.equal(names.includes("distance_m"), false);
    assert.equal(names.includes("polar_user_id"), false);
    assert.equal(names.includes("fit_base64"), false);
    const leftover = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archived_records'")
      .bind()
      .all<{ name: string }>();
    assert.equal(leftover.results?.length ?? 0, 0);

    const first = envelope({
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2018-05-15T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/exercises/aQlC83",
    });
    const second = envelope({
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2018-05-15T15:00:00Z",
      url: "https://www.polaraccesslink.com/v3/exercises/aQlC83",
    });
    await upsertPending(db, parsePolarWebhook(JSON.parse(first), first)!.ingest, new Date("2024-01-01T00:00:00.000Z"));
    await upsertPending(db, parsePolarWebhook(JSON.parse(second), second)!.ingest, new Date("2024-01-02T00:00:00.000Z"));
    const count = await db.prepare("SELECT COUNT(*) AS count FROM activities").bind().first<{ count: number }>();
    assert.equal(count?.count, 1);
    const row = await getArchivedRecord(db, {
      source: "polar",
      sourceUserId: "475",
      eventKind: "exercise",
      sourceEntityId: "aQlC83",
    });
    assert.equal(row?.status, "pending");
    assert.equal(row?.occurred_at, "2018-05-15T15:00:00Z");
    assert.equal(row?.created_at, "2024-01-01T00:00:00.000Z");
  });
});

describe("POST /webhook", () => {
  it("accepts unsigned PING only when the signature secret is not set", async () => {
    const runtime = runtimeWith();
    const ping = await handlePolarWebhook(jsonRequest({ event: "PING", timestamp: "2019-01-11T08:25:10.02Z" }), runtime);
    assert.equal(ping.status, 200);
    const exercise = await handlePolarWebhook(
      jsonRequest({ event: "EXERCISE", user_id: 1, entity_id: "abc", timestamp: "2019-01-11T08:25:10Z", url: "https://www.polaraccesslink.com/v3/exercises/abc" }),
      runtime
    );
    assert.equal(exercise.status, 401);
  });

  it("rejects a bad signature and then rate limits that IP", async () => {
    const runtime = runtimeWith({ signatureSecret: "test-secret" });
    const body = { event: "PING", timestamp: "2019-01-11T08:25:10.02Z" };
    for (let i = 0; i < WEBHOOK_FAILURE_LIMIT; i++) {
      const response = await handlePolarWebhook(jsonRequest(body, { signature: "a".repeat(64), ip: "198.51.100.10" }), runtime);
      assert.equal(response.status, 401);
    }
    const blocked = await handlePolarWebhook(
      await signedRequest(body, "test-secret", { ip: "198.51.100.10" }),
      runtime
    );
    assert.equal(blocked.status, 429);
    const otherIp = await handlePolarWebhook(await signedRequest(body, "test-secret", { ip: "198.51.100.11" }), runtime);
    assert.equal(otherIp.status, 200);
  });

  it("persists an exercise, fetches AccessLink, and ignores a hostile payload URL", async () => {
    const db = createTestDb();
    const kv = memoryKv();
    await savePolarToken(kv, 475, "token-123");
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer token-123");
      assert.equal(init?.redirect, "manual");
      if (url.includes("/fit")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      if (url.includes("/tcx")) return new Response("<TrainingCenterDatabase/>", { status: 200 });
      if (url.includes("/gpx")) return new Response("", { status: 404 });
      return Response.json({
        id: "aQlC83",
        sport: "OTHER",
        detailed_sport_info: "RUNNING",
        start_time: "2024-06-01T07:30:00",
        duration: "PT45M",
        distance: 8000,
        calories: 610,
        heart_rate: { average: 148, maximum: 172 },
        samples: [{ "sample-type": "1", "recording-rate": 5, data: "10,12,14" }],
      });
    };
    const tasks: Promise<unknown>[] = [];
    const runtime: WebhookRuntime = {
      signatureSecret: "test-secret",
      kv,
      db,
      fetchImpl,
      waitUntil(promise) {
        tasks.push(promise);
      },
    };
    const body = {
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2024-06-01T08:00:00Z",
      url: "https://evil.example/steal",
    };
    const response = await handlePolarWebhook(await signedRequest(body, "test-secret"), runtime);
    assert.equal(response.status, 200);
    await Promise.all(tasks);

    assert.ok(calls.every((url) => url.startsWith("https://www.polaraccesslink.com/")));
    assert.ok(calls.some((url) => url.includes("/v3/exercises/aQlC83?samples=true&zones=true")));
    const row = await getArchivedRecord(db, {
      source: "polar",
      sourceUserId: "475",
      eventKind: "exercise",
      sourceEntityId: "aQlC83",
    });
    assert.equal(row?.status, "archived");
    assert.equal(row?.activity_type, "RUNNING");
    assert.equal(row?.started_at, "2024-06-01T07:30:00");
    assert.equal(row?.ended_at, "2024-06-01T08:15:00");
    assert.equal(row?.duration_sec, 2700);
    assert.equal(row?.distance, 8000);
    assert.equal(row?.avg_speed, 12);
    assert.equal(row?.max_speed, 14);
    assert.equal(row?.calories, 610);
    assert.equal(row?.avg_hr, 148);
    assert.equal(row?.max_hr, 172);
    const artifacts = JSON.parse(row?.artifacts_json || "[]") as ArchiveArtifact[];
    assert.equal(artifacts.find((artifact) => artifact.kind === "fit")?.body, Buffer.from([1, 2, 3, 4]).toString("base64"));
    assert.equal(artifacts.find((artifact) => artifact.kind === "tcx")?.body, "<TrainingCenterDatabase/>");
    assert.equal(artifacts.find((artifact) => artifact.kind === "gpx")?.status, "unavailable");
    assert.equal(artifacts.find((artifact) => artifact.kind === "gpx")?.body, null);
    const normalized = JSON.parse(row?.normalized || "{}") as { activity_type?: string };
    assert.equal(normalized.activity_type, "RUNNING");

    const listed = await listArchivedRecords(db, { source: "polar", sourceUserId: "475", eventKind: "exercise" });
    assert.equal(listed.length, 1);
    assert.equal("raw_payload" in listed[0], false);
  });

  it("stores missing_token without calling Polar when the user has not connected", async () => {
    const db = createTestDb();
    let fetches = 0;
    const tasks: Promise<unknown>[] = [];
    const runtime: WebhookRuntime = {
      signatureSecret: "test-secret",
      kv: memoryKv(),
      db,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("no");
      },
      waitUntil(promise) {
        tasks.push(promise);
      },
    };
    const response = await handlePolarWebhook(
      await signedRequest(
        {
          event: "ACTIVITY_SUMMARY",
          user_id: 475,
          date: "2022-09-30",
          timestamp: "2022-10-02T14:22:24Z",
          url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
        },
        "test-secret"
      ),
      runtime
    );
    assert.equal(response.status, 200);
    await Promise.all(tasks);
    assert.equal(fetches, 0);
    const row = await getArchivedRecord(db, {
      source: "polar",
      sourceUserId: "475",
      eventKind: "activity_summary",
      sourceEntityId: "2022-09-30",
    });
    assert.equal(row?.status, "missing_token");
    assert.equal(row?.event_kind, "activity_summary");
  });

  it("does not fetch a sleepwise URL outside AccessLink", async () => {
    const db = createTestDb();
    const kv = memoryKv();
    await savePolarToken(kv, 475, "token-123");
    let fetches = 0;
    const tasks: Promise<unknown>[] = [];
    const runtime: WebhookRuntime = {
      signatureSecret: "test-secret",
      kv,
      db,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("{}");
      },
      waitUntil(promise) {
        tasks.push(promise);
      },
    };
    const response = await handlePolarWebhook(
      await signedRequest(
        {
          event: "SLEEP_WISE_ALERTNESS",
          user_id: 475,
          from: "2022-09-30",
          to: "2022-10-02",
          timestamp: "2022-10-02T14:22:24Z",
          url: "https://evil.example/steal",
        },
        "test-secret"
      ),
      runtime
    );
    assert.equal(response.status, 200);
    await Promise.all(tasks);
    assert.equal(fetches, 0);
    const row = await getArchivedRecord(db, {
      source: "polar",
      sourceUserId: "475",
      eventKind: "sleep_wise_alertness",
      sourceEntityId: "2022-09-30_2022-10-02",
    });
    assert.equal(row?.status, "failed");
    assert.match(row?.error || "", /Refusing/);
    assert.equal(row?.attempts, 8);
  });

  it("retries a failed row once a token fetch succeeds", async () => {
    const db = createTestDb();
    const kv = memoryKv();
    await savePolarToken(kv, 475, "token-123");
    const raw = JSON.stringify({
      event: "ACTIVITY_SUMMARY",
      user_id: 475,
      date: "2022-09-30",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
    });
    const ingest = parsePolarWebhook(JSON.parse(raw), raw)!.ingest;
    await upsertPending(db, ingest, new Date("2020-01-01T00:00:00.000Z"));
    await markArchiveStatus(db, ingest, "failed", "Polar API 500 for activity_summary", {}, new Date("2020-01-01T00:00:00.000Z"));

    const due = await listRetryCandidates(db, "2020-01-01T00:05:00.000Z", 10);
    assert.equal(due.length, 1);

    const result = await retryIncompleteArchives(
      {
        db,
        kv,
        fetchImpl: async (input) => {
          assert.equal(String(input), "https://www.polaraccesslink.com/v3/users/activities/2022-09-30");
          return Response.json({ date: "2022-09-30", steps: 12345 });
        },
      },
      { now: new Date("2020-01-01T00:10:00.000Z") }
    );
    assert.equal(result.archived, 1);
    const row = await getArchivedRecord(db, {
      source: "polar",
      sourceUserId: "475",
      eventKind: "activity_summary",
      sourceEntityId: "2022-09-30",
    });
    assert.equal(row?.status, "archived");
    assert.match(row?.raw_payload || "", /12345/);
    const normalized = JSON.parse(row?.normalized || "{}") as { extras?: { steps?: number } };
    assert.equal(normalized.extras?.steps, 12345);
    assert.equal(await loadPolarToken(kv, 475), "token-123");
  });
});

function envelope(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function normalizedFixture(overrides: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    startedAt: null,
    endedAt: null,
    durationSec: null,
    activityType: null,
    distance: null,
    calories: null,
    avgHr: null,
    maxHr: null,
    avgSpeed: null,
    maxSpeed: null,
    title: null,
    document: { activity_type: overrides.activityType ?? null },
    rawPayload: {},
    artifacts: [],
    bulkyKeys: ["samples", "route"],
    ...overrides,
  };
}

function createTestDb(): ArchiveDb {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "migrations/0001_init_archive.sql",
    "migrations/0002_canonical_archive.sql",
    "migrations/0003_activities.sql",
  ]) {
    sqlite.exec(readFileSync(join(root, file), "utf8"));
  }
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

function memoryKv(): KvStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

function runtimeWith(extra: Partial<WebhookRuntime> = {}): WebhookRuntime {
  const tasks: Promise<unknown>[] = [];
  return {
    kv: memoryKv(),
    db: createTestDb(),
    waitUntil(promise) {
      tasks.push(promise);
    },
    ...extra,
  };
}

function jsonRequest(body: unknown, options: { signature?: string; ip?: string } = {}): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Polar-Webhook-Event": String((body as { event?: string }).event ?? ""),
    "CF-Connecting-IP": options.ip ?? "203.0.113.8",
  });
  if (options.signature) headers.set("Polar-Webhook-Signature", options.signature);
  return new Request("https://polar-mcp-server.yafoy.workers.dev/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function signedRequest(body: { event: string }, secret: string, options: { ip?: string } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const signature = await signPolarWebhookBody(raw, secret);
  return new Request("https://polar-mcp-server.yafoy.workers.dev/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Polar-Webhook-Event": body.event,
      "Polar-Webhook-Signature": signature,
      "CF-Connecting-IP": options.ip ?? "203.0.113.8",
    },
    body: raw,
  });
}
