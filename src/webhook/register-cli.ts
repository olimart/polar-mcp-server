#!/usr/bin/env node

/**
 * Register the one Polar AccessLink webhook for this client.
 *
 * Polar sends PING to the URL during create, so the Worker must already be
 * deployed and answering POST /webhook. signature_secret_key is returned once.
 * This script prints it or pipes it to `wrangler secret put`. It never writes
 * the secret to a file.
 *
 * Usage:
 *   POLAR_CLIENT_ID=... POLAR_CLIENT_SECRET=... npm run webhook:status
 *   POLAR_CLIENT_ID=... POLAR_CLIENT_SECRET=... npm run webhook:register -- --set-secret
 *   npm run webhook:register -- --events EXERCISE,ACTIVITY_SUMMARY --update
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import {
  getWebhookRegistration,
  parseWebhookEvents,
  polarClientRequest,
  publicWebhookRegistration,
  readWebhookRegistration,
} from "./polar-webhook-api.js";
import { DEFAULT_WORKER_ORIGIN, webhookUrlFromOrigin } from "../providers/polar/webhook.js";

const SECRET_NAME = "POLAR_WEBHOOK_SIGNATURE_SECRET";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      status: { type: "boolean", default: false },
      "set-secret": { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      activate: { type: "boolean", default: false },
      url: { type: "string" },
      events: { type: "string" },
    },
  });

  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set POLAR_CLIENT_ID and POLAR_CLIENT_SECRET.");
    process.exit(1);
  }

  const origin = process.env.WEBHOOK_BASE_URL || DEFAULT_WORKER_ORIGIN;
  const url = values.url || webhookUrlFromOrigin(origin);
  const events = parseWebhookEvents(values.events || process.env.POLAR_WEBHOOK_EVENTS);

  if (values.status) {
    const current = await getWebhookRegistration(clientId, clientSecret);
    console.log(JSON.stringify({ expected_url: url, webhook: publicWebhookRegistration(current) }, null, 2));
    return;
  }

  let current = await getWebhookRegistration(clientId, clientSecret);
  if (!current) {
    const created = await polarClientRequest("/webhooks", clientId, clientSecret, {
      method: "POST",
      body: JSON.stringify({ events, url }),
    });
    if (created.status === 409) {
      current = await getWebhookRegistration(clientId, clientSecret);
      console.log("Webhook already exists. Polar only keeps one per client, and the signature secret cannot be read again.");
    } else if (created.status !== 201 && created.status !== 200) {
      console.error(`Create webhook failed (${created.status}) ${errorMessage(created.body)}`);
      process.exit(1);
    } else {
      const registration = readWebhookRegistration(created.body);
      console.log("Webhook created.");
      console.log(JSON.stringify(publicWebhookRegistration(registration), null, 2));
      if (registration?.signatureSecret) {
        await persistSignatureSecret(registration.signatureSecret, values["set-secret"] === true);
      } else {
        console.error("Create succeeded but no signature_secret_key was returned. Check the Polar response manually.");
        process.exit(1);
      }
      current = registration;
    }
  } else if (values.update) {
    if (!current.id) {
      console.error("Existing webhook has no id; cannot update.");
      process.exit(1);
    }
    const updated = await polarClientRequest(`/webhooks/${encodeURIComponent(current.id)}`, clientId, clientSecret, {
      method: "PATCH",
      body: JSON.stringify({ events, url }),
    });
    if (updated.status !== 200) {
      console.error(`Update webhook failed (${updated.status}) ${errorMessage(updated.body)}`);
      process.exit(1);
    }
    current = readWebhookRegistration(updated.body) ?? current;
    console.log("Webhook updated. Changing the URL makes Polar send a new PING.");
    console.log(JSON.stringify(publicWebhookRegistration(current), null, 2));
  } else {
    console.log("Webhook already exists. Pass --update to change events or url.");
    console.log("The signature secret was only returned when the webhook was created.");
    console.log(JSON.stringify({ expected_url: url, webhook: publicWebhookRegistration(current) }, null, 2));
  }

  if (values.activate) {
    const activated = await polarClientRequest("/webhooks/activate", clientId, clientSecret, { method: "POST" });
    if (activated.status !== 200) {
      console.error(`Activate webhook failed (${activated.status}) ${errorMessage(activated.body)}`);
      process.exit(1);
    }
    console.log("Webhook activate request succeeded (Polar PING'd the URL).");
  }
}

async function persistSignatureSecret(secret: string, setSecret: boolean): Promise<void> {
  if (!setSecret) {
    console.log("");
    console.log("signature_secret_key (shown once; Polar will not return it again):");
    console.log(secret);
    console.log("");
    console.log(`Store it with: npx wrangler secret put ${SECRET_NAME}`);
    return;
  }

  try {
    await putWorkerSecret(SECRET_NAME, secret);
    console.log(`Stored ${SECRET_NAME} with wrangler. Polar will not show this key again.`);
  } catch (error) {
    console.error("Failed to store the signature secret. Copy it now; Polar will not show it again:");
    console.error(secret);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function putWorkerSecret(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, CI: "1" },
    });
    child.on("error", reject);
    child.stdin.write(value);
    child.stdin.end();
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put exited ${code}`));
    });
  });
}

function errorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 300) : "";
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
