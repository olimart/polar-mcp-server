#!/usr/bin/env node

/**
 * Import every Strava activity for one athlete into the activities table.
 *
 *   STRAVA_ACCESS_TOKEN=... npm run strava:import -- --sqlite ./strava.sqlite
 *   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=... \
 *     CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run strava:import
 *
 * Tokens are read from the environment and are not printed.
 * --dry-run lists activities and does not write.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { archiveMapped } from "../../archive/apply.js";
import type { ArchiveDb, PreparedStatement } from "../../archive/db.js";
import { fetchStravaAthlete, listStravaActivities, refreshStravaAccessToken } from "./client.js";
import { adaptStravaActivity } from "./mapper.js";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sqlite: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const accessToken = await resolveAccessToken();
  const athlete = await fetchStravaAthlete(accessToken);
  const activities = await listStravaActivities(accessToken);
  console.log(`Strava athlete ${athlete.id}: ${activities.length} activities`);

  if (values["dry-run"]) return;

  const db = openDatabase(values.sqlite);
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
  console.log(`Imported ${imported}, skipped ${skipped}`);
}

async function resolveAccessToken(): Promise<string> {
  const direct = process.env.STRAVA_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  const clientId = process.env.STRAVA_CLIENT_ID?.trim();
  const clientSecret = process.env.STRAVA_CLIENT_SECRET?.trim();
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) {
    const refreshed = await refreshStravaAccessToken({ clientId, clientSecret, refreshToken });
    return refreshed.accessToken;
  }
  throw new Error(
    "Set STRAVA_ACCESS_TOKEN, or STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_REFRESH_TOKEN."
  );
}

function openDatabase(sqlitePath: string | undefined): ArchiveDb {
  if (sqlitePath) return sqliteDatabase(sqlitePath);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const databaseId = process.env.ARCHIVE_DATABASE_ID?.trim() || databaseIdFromWrangler();
  if (!accountId || !apiToken || !databaseId || databaseId === PLACEHOLDER_DATABASE_ID) {
    throw new Error(
      "Pass --sqlite <file>, or set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and a real ARCHIVE_DATABASE_ID (wrangler.toml still has the placeholder)."
    );
  }
  return cloudflareD1(accountId, databaseId, apiToken);
}

function sqliteDatabase(path: string): ArchiveDb {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(readFileSync(new URL("../../../migrations/0001_init_archive.sql", import.meta.url), "utf8"));
  return {
    prepare(query: string): PreparedStatement {
      const statement = sqlite.prepare(query);
      let bound: Array<string | number | null | bigint> = [];
      const prepared: PreparedStatement = {
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

function cloudflareD1(accountId: string, databaseId: string, apiToken: string): ArchiveDb {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return {
    prepare(sql: string): PreparedStatement {
      let params: unknown[] = [];
      const prepared: PreparedStatement = {
        bind(...values: unknown[]) {
          params = values.map((value) => (value === undefined ? null : value));
          return prepared;
        },
        async run() {
          await d1(endpoint, apiToken, sql, params);
          return { success: true };
        },
        async first<T>() {
          const rows = await d1(endpoint, apiToken, sql, params);
          return (rows[0] as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: (await d1(endpoint, apiToken, sql, params)) as T[] };
        },
      };
      return prepared;
    },
  };
}

async function d1(endpoint: string, apiToken: string, sql: string, params: unknown[]): Promise<unknown[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!response.ok) {
    throw new Error(`D1 query failed (${response.status})`);
  }
  const parsed = (await response.json()) as { success?: boolean; errors?: { message?: string }[]; result?: { results?: unknown[] }[] };
  if (!parsed.success) {
    throw new Error(parsed.errors?.[0]?.message || "D1 query failed");
  }
  return parsed.result?.[0]?.results ?? [];
}

function databaseIdFromWrangler(): string | null {
  try {
    const toml = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
    const match = /\[\[d1_databases\]\][^\[]*?database_id\s*=\s*"([^"]+)"/.exec(toml);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Strava import failed";
  console.error(message);
  process.exitCode = 1;
});
