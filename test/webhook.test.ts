import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getArchivedEvent,
  listArchivedEvents,
  listRetryCandidates,
  markArchiveStatus,
  upsertPending,
  type ArchiveDb,
} from "../src/webhook/archive.js";
import { handlePolarWebhook, WEBHOOK_FAILURE_LIMIT, type WebhookRuntime } from "../src/webhook/handle.js";
import {
  MAX_PAYLOAD_CHARS,
  assertPolarResourceUrl,
  extractExerciseSummary,
  isPingEvent,
  packArchiveParts,
  parseWebhookNotification,
  resourceUrlFor,
  webhookUrlFromOrigin,
} from "../src/webhook/payload.js";
import {
  publicWebhookRegistration,
  readWebhookRegistration,
} from "../src/webhook/polar-webhook-api.js";
import { retryIncompleteArchives } from "../src/webhook/retry.js";
import { signPolarWebhookBody, verifyPolarWebhookSignature } from "../src/webhook/signature.js";
import { loadPolarToken, savePolarToken, type KvStore } from "../src/webhook/token-store.js";

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
    const exercise = parseWebhookNotification({
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2018-05-15T14:22:24Z",
      url: "https://evil.example/not-used",
    });
    assert.equal(exercise?.entityId, "aQlC83");
    assert.equal(exercise?.userId, "475");
    assert.equal(
      resourceUrlFor(exercise!),
      "https://www.polaraccesslink.com/v3/exercises/aQlC83?samples=true&zones=true"
    );

    const activity = parseWebhookNotification({
      event: "ACTIVITY_SUMMARY",
      user_id: "475",
      date: "2022-09-30",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
    });
    assert.equal(activity?.entityId, "2022-09-30");
    assert.equal(resourceUrlFor(activity!), "https://www.polaraccesslink.com/v3/users/activities/2022-09-30");

    const alertness = parseWebhookNotification({
      event: "SLEEP_WISE_ALERTNESS",
      user_id: 475,
      from: "2022-09-30",
      to: "2022-10-02",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/sleepwise/alertness/date?from=2022-09-30&to=2022-10-02",
    });
    assert.equal(alertness?.entityId, "2022-09-30_2022-10-02");
    assert.equal(isPingEvent({ event: "PING", timestamp: "2018-05-15T14:22:24Z" }, "PING"), true);
    assert.equal(parseWebhookNotification({ event: "PING" }), null);
    assert.equal(parseWebhookNotification({ event: "EXERCISE", user_id: 1, entity_id: "../etc" }), null);
  });

  it("refuses non-AccessLink URLs", () => {
    assert.throws(() => assertPolarResourceUrl("http://www.polaraccesslink.com/v3/exercises/1"), /Refusing/);
    assert.throws(() => assertPolarResourceUrl("https://evil.example/v3/exercises/1"), /Refusing/);
    assert.throws(() => assertPolarResourceUrl("https://www.polaraccesslink.com/v3/../secret"), /Refusing/);
    const allowed = assertPolarResourceUrl("https://www.polaraccesslink.com/v3/exercises/aQlC83");
    assert.equal(allowed.hostname, "www.polaraccesslink.com");
  });

  it("reads snake_case and kebab-case exercise summaries", () => {
    const summary = extractExerciseSummary({
      sport: "OTHER",
      detailed_sport_info: "RUNNING",
      start_time: "2008-10-13T10:40:02",
      duration: "PT2H44M",
      distance: 1600,
      calories: 530,
      heart_rate: { average: 129.2, maximum: 147 },
    });
    assert.deepEqual(summary, {
      sport: "RUNNING",
      startTime: "2008-10-13T10:40:02",
      duration: "PT2H44M",
      distanceM: 1600,
      calories: 530,
      hrAvg: 129,
    });
    const legacy = extractExerciseSummary({
      sport: "OTHER",
      "detailed-sport-info": "CYCLING",
      "start-time": "2008-10-13T10:40:02",
      "heart-rate": { average: 100, maximum: 120 },
    });
    assert.equal(legacy.sport, "CYCLING");
    assert.equal(legacy.hrAvg, 100);
  });

  it("drops exports that would exceed the D1 row budget", () => {
    const packed = packArchiveParts({
      payload: { sport: "RUNNING", note: "n".repeat(600_000) },
      fitBase64: "A".repeat(400_000),
      tcx: null,
      gpx: null,
      exportNotes: { fit: "stored" },
    });
    assert.equal(packed.fitBase64, null);
    assert.equal(JSON.parse(packed.exportsJson).fit, "omitted_row_limit");
    assert.equal(packed.summary.sport, "RUNNING");
    assert.ok(packed.payload.length < MAX_PAYLOAD_CHARS);
  });

  it("strips bulky samples before storing", () => {
    const packed = packArchiveParts({
      payload: { sport: "RUNNING", samples: [{ data: "x".repeat(MAX_PAYLOAD_CHARS) }] },
      fitBase64: null,
      tcx: null,
      gpx: null,
      exportNotes: {},
    });
    const stored = JSON.parse(packed.payload) as { samples?: unknown; sport?: string };
    assert.equal(stored.samples, undefined);
    assert.equal(stored.sport, "RUNNING");
    assert.equal(JSON.parse(packed.exportsJson).samples, "omitted_size");
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
  it("applies the migration and upserts one row per user, event, and entity", async () => {
    const db = createTestDb();
    const notification = parseWebhookNotification({
      event: "EXERCISE",
      user_id: 475,
      entity_id: "aQlC83",
      timestamp: "2018-05-15T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/exercises/aQlC83",
    })!;
    await upsertPending(db, notification, JSON.stringify(notification), new Date("2024-01-01T00:00:00.000Z"));
    await upsertPending(
      db,
      { ...notification, timestamp: "2018-05-15T15:00:00Z" },
      "{\"event\":\"EXERCISE\"}",
      new Date("2024-01-02T00:00:00.000Z")
    );
    const count = await db.prepare("SELECT COUNT(*) AS count FROM archived_events").bind().first<{ count: number }>();
    assert.equal(count?.count, 1);
    const row = await getArchivedEvent(db, { userId: "475", event: "EXERCISE", entityId: "aQlC83" });
    assert.equal(row?.status, "pending");
    assert.equal(row?.event_timestamp, "2018-05-15T15:00:00Z");
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
    const row = await getArchivedEvent(db, {
      userId: "475",
      event: "EXERCISE",
      entityId: "aQlC83",
      includeExports: true,
    });
    assert.equal(row?.status, "archived");
    assert.equal(row?.sport, "RUNNING");
    assert.equal(row?.start_time, "2024-06-01T07:30:00");
    assert.equal(row?.distance_m, 8000);
    assert.equal(row?.hr_avg, 148);
    assert.equal(row?.fit_base64, Buffer.from([1, 2, 3, 4]).toString("base64"));
    assert.equal(row?.tcx, "<TrainingCenterDatabase/>");
    assert.equal(row?.gpx, null);
    const notes = JSON.parse(row?.exports_json || "{}") as { gpx?: string };
    assert.equal(notes.gpx, "unavailable");

    const listed = await listArchivedEvents(db, { userId: "475", event: "EXERCISE" });
    assert.equal(listed.length, 1);
    assert.equal("payload" in listed[0], false);
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
    const row = await getArchivedEvent(db, { userId: "475", event: "ACTIVITY_SUMMARY", entityId: "2022-09-30" });
    assert.equal(row?.status, "missing_token");
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
    const row = await getArchivedEvent(db, {
      userId: "475",
      event: "SLEEP_WISE_ALERTNESS",
      entityId: "2022-09-30_2022-10-02",
    });
    assert.equal(row?.status, "failed");
    assert.match(row?.error || "", /Refusing/);
    assert.equal(row?.attempts, 8);
  });

  it("retries a failed row once a token fetch succeeds", async () => {
    const db = createTestDb();
    const kv = memoryKv();
    await savePolarToken(kv, 475, "token-123");
    const notification = parseWebhookNotification({
      event: "ACTIVITY_SUMMARY",
      user_id: 475,
      date: "2022-09-30",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
    })!;
    const raw = JSON.stringify({
      event: "ACTIVITY_SUMMARY",
      user_id: 475,
      date: "2022-09-30",
      timestamp: "2022-10-02T14:22:24Z",
      url: "https://www.polaraccesslink.com/v3/users/activities/2022-09-30",
    });
    await upsertPending(db, notification, raw, new Date("2020-01-01T00:00:00.000Z"));
    await markArchiveStatus(db, notification, "failed", "Polar API 500 for ACTIVITY_SUMMARY", {}, new Date("2020-01-01T00:00:00.000Z"));

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
    const row = await getArchivedEvent(db, { userId: "475", event: "ACTIVITY_SUMMARY", entityId: "2022-09-30" });
    assert.equal(row?.status, "archived");
    assert.match(row?.payload || "", /12345/);
    assert.equal(await loadPolarToken(kv, 475), "token-123");
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
