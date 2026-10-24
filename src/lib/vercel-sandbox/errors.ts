import "server-only";

import { redactSecrets } from "@/lib/sandbox/command";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function formatVercelSandboxError(
  error: unknown,
  secrets: Array<string | undefined> = [],
): string {
  // The SDK ships separate ESM and CommonJS APIError constructors. Match its
  // response contract for display instead of relying on constructor identity.
  const response = error instanceof Error ? record(record(error)?.response) : undefined;
  if (typeof response?.status !== "number") {
    return redactSecrets(
      error instanceof Error ? error.message : "Vercel Sandbox request failed.",
      secrets,
    );
  }

  const body = record(record(error)?.json);
  const detail = record(body?.error) ?? body;
  const code = typeof detail?.code === "string" ? detail.code : undefined;
  const message =
    typeof detail?.message === "string"
      ? detail.message
      : typeof body?.error === "string"
        ? body.error
        : undefined;
  const status = response.status;
  const fallback =
    status === 401 || status === 403
      ? "Check the saved Vercel token, its team access, and the connected project."
      : (error instanceof Error && error.message) ||
        "Check the connected Vercel project and try again.";
  // Only persist the provider's error code/message, never its raw response,
  // headers, or request body. Redact before truncation to avoid partial tokens.
  const safeCode = code ? redactSecrets(code, secrets).slice(0, 100) : undefined;
  const safeMessage = redactSecrets(message || fallback, secrets).slice(0, 1000);
  return `Vercel Sandbox request failed (${status}${safeCode ? `; ${safeCode}` : ""}): ${safeMessage}`;
}
