/**
 * Polar AccessLink signs webhook bodies with HMAC-SHA256.
 * The hex digest is sent in the Polar-Webhook-Signature header.
 * The key is signature_secret_key from webhook creation (shown once).
 */

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function normalizeSignatureHeader(header: string): string {
  let value = header.trim();
  if (value.toLowerCase().startsWith("sha256=")) {
    value = value.slice("sha256=".length).trim();
  }
  return value.toLowerCase();
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

export async function signPolarWebhookBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return bufferToHex(mac);
}

export async function verifyPolarWebhookSignature(
  body: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader || !secret) {
    return false;
  }
  const provided = normalizeSignatureHeader(signatureHeader);
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  const expected = await signPolarWebhookBody(body, secret);
  return timingSafeEqual(expected, provided);
}

export function hasSignatureSecret(secret: string | undefined | null): secret is string {
  return typeof secret === "string" && secret.trim().length > 0;
}
