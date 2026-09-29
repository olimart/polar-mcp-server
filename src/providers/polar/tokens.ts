/**
 * Polar access tokens do not expire. The OAuth provider stores them inside
 * MCP grant props, which webhooks cannot look up by Polar user id.
 * Never log the stored value.
 */

import type { KvStore } from "../kv.js";

export function polarTokenKey(userId: string | number): string {
  return `polar_token:${userId}`;
}

export async function savePolarToken(kv: KvStore, userId: string | number, accessToken: string): Promise<void> {
  if (!accessToken) return;
  await kv.put(
    polarTokenKey(userId),
    JSON.stringify({
      userId: String(userId),
      accessToken,
      updatedAt: new Date().toISOString(),
    })
  );
}

export async function loadPolarToken(kv: KvStore, userId: string | number): Promise<string | null> {
  const raw = await kv.get(polarTokenKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { accessToken?: unknown };
    return typeof parsed.accessToken === "string" && parsed.accessToken.length > 0
      ? parsed.accessToken
      : null;
  } catch {
    return null;
  }
}
