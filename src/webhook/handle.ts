/**
 * POST /webhook for the Polar provider.
 * Signature checks and AccessLink fetches live in the Polar adapter.
 */

import { handleProviderWebhook, type WebhookRuntime } from "../archive/ingest.js";
import { polarArchiveProvider } from "../providers/polar/adapter.js";

export { WEBHOOK_FAILURE_LIMIT, type WebhookRuntime } from "../archive/ingest.js";

export function handlePolarWebhook(request: Request, runtime: WebhookRuntime): Promise<Response> {
  return handleProviderWebhook(polarArchiveProvider, request, runtime);
}
