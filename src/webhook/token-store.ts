/**
 * Polar access tokens do not expire. The OAuth provider stores them inside
 * MCP grant props, which webhooks cannot look up by Polar user id.
 * A copy keyed by polar user id lets the webhook worker fetch new data.
 * Never log the stored value.
 */

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

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
