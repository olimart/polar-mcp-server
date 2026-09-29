/**
 * Read the authenticated athlete's activities from Strava.
 * The list endpoint is newest-first and pages at 200. Tokens are not logged.
 */

import { STRAVA_API_ORIGIN } from "./mapper.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 500;

export interface StravaAthlete {
  id: string;
}

export async function fetchStravaAthlete(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<StravaAthlete> {
  const body = await stravaJson(fetchImpl, `${STRAVA_API_ORIGIN}/athlete`, accessToken);
  const record = asRecord(body);
  const id = record && (typeof record.id === "number" || typeof record.id === "string") ? String(record.id) : "";
  if (!/^[0-9]{1,32}$/.test(id)) {
    throw new Error("Strava athlete response has no id");
  }
  return { id };
}

/** Every activity summary for the token's athlete, oldest pages included. */
export async function listStravaActivities(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  pageSize = PAGE_SIZE
): Promise<unknown[]> {
  const activities: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${STRAVA_API_ORIGIN}/athlete/activities?page=${page}&per_page=${pageSize}`;
    const batch = await stravaJson(fetchImpl, url, accessToken);
    if (!Array.isArray(batch)) {
      throw new Error("Strava activities response was not a list");
    }
    activities.push(...batch);
    if (batch.length < pageSize) break;
  }
  return activities;
}

async function stravaJson(fetchImpl: typeof fetch, url: string, accessToken: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Refusing redirect from Strava");
  }
  if (response.status === 401) {
    throw new Error("Strava rejected the access token");
  }
  if (response.status === 429) {
    throw new Error("Strava rate limit reached");
  }
  if (!response.ok) {
    throw new Error(`Strava API ${response.status}`);
  }
  return (await response.json()) as unknown;
}

export async function refreshStravaAccessToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  const response = await fetchImpl("https://www.strava.com/oauth/token", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Strava token refresh failed (${response.status})`);
  }
  const parsed = asRecord(await response.json());
  const accessToken = parsed && typeof parsed.access_token === "string" ? parsed.access_token : "";
  const refreshToken = parsed && typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  if (!accessToken) throw new Error("Strava token refresh returned no access token");
  return { accessToken, refreshToken: refreshToken || input.refreshToken };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
