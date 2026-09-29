/**
 * Worker-only MCP tools over the D1 archive.
 * The local stdio server has no D1 binding, so these are not registered there.
 * Pull tools still read AccessLink directly. This archive is the long-term store.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getArchivedEvent, listArchivedEvents, type ArchiveDb, type ArchivedEventDetail } from "./archive.js";
import { getWebhookRegistration, publicWebhookRegistration } from "./polar-webhook-api.js";
import {
  DEFAULT_WORKER_ORIGIN,
  webhookUrlFromOrigin,
} from "./payload.js";

interface ArchiveToolEnv {
  ARCHIVE_DB?: ArchiveDb;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  WEBHOOK_BASE_URL?: string;
}

const EXPORT_RESPONSE_CHAR_CAP = 200_000;

export function registerArchiveTools(server: McpServer, env: ArchiveToolEnv, userId: string | number): void {
  const polarUserId = String(userId);

  server.tool(
    "list_archived_events",
    "List Polar events archived from AccessLink webhooks for the authenticated user. Defaults to EXERCISE. This is the durable copy kept after AccessLink's ~30-day window. Only data uploaded after the user registered with this app is present; older history is not imported.",
    {
      event: z
        .string()
        .optional()
        .describe("Event type. Defaults to EXERCISE. ACTIVITY_SUMMARY is also archived when subscribed."),
      from: z.string().optional().describe("Inclusive start (YYYY-MM-DD or ISO timestamp)."),
      to: z.string().optional().describe("Inclusive end (YYYY-MM-DD or ISO timestamp)."),
      limit: z.number().optional().describe("Max rows (1-100, default 20)."),
    },
    async ({ event, from, to, limit }) => {
      if (!env.ARCHIVE_DB) {
        return errorResult("Archive database is not configured.");
      }
      try {
        const rows = await listArchivedEvents(env.ARCHIVE_DB, {
          userId: polarUserId,
          event: event ?? "EXERCISE",
          from,
          to,
          limit,
        });
        return jsonResult({
          note: "Sessions from before this user registered with the app are not in the archive.",
          events: rows,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    "get_archived_event",
    "Get one archived Polar webhook record for the authenticated user, including the stored JSON payload. Exercise samples and route points are omitted unless include_samples is true. FIT/TCX/GPX are omitted unless include_exports is true.",
    {
      event: z.string().describe("Event type, for example EXERCISE or ACTIVITY_SUMMARY."),
      entityId: z.string().describe("Exercise id, or the date (YYYY-MM-DD) for daily events."),
      include_samples: z.boolean().optional().describe("Include exercise samples and route arrays. Default false."),
      include_exports: z.boolean().optional().describe("Include stored FIT (base64), TCX, and GPX when they fit in a tool response."),
    },
    async ({ event, entityId, include_samples, include_exports }) => {
      if (!env.ARCHIVE_DB) {
        return errorResult("Archive database is not configured.");
      }
      try {
        const row = await getArchivedEvent(env.ARCHIVE_DB, {
          userId: polarUserId,
          event,
          entityId,
          includeExports: include_exports === true,
        });
        if (!row) {
          return jsonResult({
            message: "No archived event found for this user.",
            event,
            entityId,
          });
        }
        return jsonResult(presentEvent(row, include_samples === true, include_exports === true));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    "get_webhook_registration",
    "Show the AccessLink webhook registered for this Polar client (id, url, events, active). Does not return the signature secret. One webhook is allowed per client.",
    {},
    async () => {
      if (!env.POLAR_CLIENT_ID || !env.POLAR_CLIENT_SECRET) {
        return errorResult("Polar client credentials are not configured.");
      }
      try {
        const registration = await getWebhookRegistration(env.POLAR_CLIENT_ID, env.POLAR_CLIENT_SECRET);
        const expectedUrl = webhookUrlFromOrigin(env.WEBHOOK_BASE_URL || DEFAULT_WORKER_ORIGIN);
        const pub = publicWebhookRegistration(registration);
        return jsonResult({
          expected_url: expectedUrl,
          matches_expected_url: pub?.url === expectedUrl,
          webhook: pub,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}

function presentEvent(
  row: ArchivedEventDetail,
  includeSamples: boolean,
  includeExports: boolean
): Record<string, unknown> {
  const { fit_base64, tcx, gpx, payload, ...rest } = row;
  const presented: Record<string, unknown> = {
    ...rest,
    payload: presentPayload(payload, includeSamples),
    exports: parseJson(row.exports_json),
  };
  if (includeExports) {
    presented.fit_base64 = capExport(fit_base64 ?? null);
    presented.tcx = capExport(tcx ?? null);
    presented.gpx = capExport(gpx ?? null);
  }
  return presented;
}

function presentPayload(payload: string | null, includeSamples: boolean): unknown {
  const parsed = parseJson(payload);
  if (!includeSamples && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const copy = { ...(parsed as Record<string, unknown>) };
    delete copy.samples;
    delete copy.route;
    return copy;
  }
  return parsed;
}

function capExport(value: string | null): string | { omitted: true; chars: number } | null {
  if (value === null) return null;
  if (value.length > EXPORT_RESPONSE_CHAR_CAP) {
    return { omitted: true, chars: value.length };
  }
  return value;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}
