import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Props = {
  accessToken: string;
  userId: number;
} & Record<string, unknown>;

export interface Env {
  POLAR_CLIENT_ID: string;
  POLAR_CLIENT_SECRET: string;
  /** HMAC key returned once when the AccessLink webhook is created. Worker secret. */
  POLAR_WEBHOOK_SIGNATURE_SECRET?: string;
  /** Public origin used to show the expected webhook URL. Not a secret. */
  WEBHOOK_BASE_URL?: string;
  OAUTH_KV: KVNamespace;
  ARCHIVE_DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}
