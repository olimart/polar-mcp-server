/** Strip secrets from messages that may be stored or logged. */
export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/signature_secret_key["']?\s*[:=]\s*["'][^"']+["']/gi, "signature_secret_key=[redacted]")
    .replace(/accessToken["']?\s*[:=]\s*["'][^"']+["']/gi, "accessToken=[redacted]")
    .slice(0, 300);
}
