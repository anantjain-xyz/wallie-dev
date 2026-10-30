import "server-only";

import { redactSecrets } from "@/lib/sandbox/command";

/** Persisted response bodies stay around 2KB after redaction. */
const RESPONSE_BODY_LIMIT = 2_048;

const responseMethods = new WeakMap<Response, string>();

function redactJsonSecretValues(value: string): string {
  return value.replace(
    /("(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|private[_-]?key|secret|token)"\s*:\s*")(?:\\.|[^"\\])*(")/gi,
    `$1[REDACTED]$2`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (typeof init?.method === "string" && init.method.trim()) {
    return init.method.trim().toUpperCase();
  }
  if (typeof Request !== "undefined" && input instanceof Request && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

/**
 * Fetch wrapper that remembers the HTTP method for later error reporting.
 * The Fetch Response itself does not expose the request method.
 */
export function vercelSandboxFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = requestMethod(input, init);
  return fetch(input, init).then((response) => {
    responseMethods.set(response, method);
    return response;
  });
}

export function isVercelSandboxApiError(error: unknown): boolean {
  return typeof vercelResponse(error)?.status === "number";
}

export function vercelSandboxErrorStatus(error: unknown): number | undefined {
  const status = vercelResponse(error)?.status;
  return typeof status === "number" ? status : undefined;
}

function vercelResponse(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) return undefined;
  return record(record(error)?.response);
}

function responseMethod(response: Record<string, unknown>): string | undefined {
  if (response instanceof Response) {
    const remembered = responseMethods.get(response);
    if (remembered) return remembered;
  }
  return typeof response.method === "string" && /^[A-Z]+$/.test(response.method)
    ? response.method
    : undefined;
}

function responseUrl(response: Record<string, unknown>): string | undefined {
  if (typeof response.url !== "string") return undefined;
  const url = response.url.trim();
  return url.length > 0 ? url : undefined;
}

function responseBody(error: Record<string, unknown>): string | undefined {
  if (typeof error.text === "string" && error.text.length > 0) return error.text;
  if (error.json === undefined) return undefined;
  try {
    const serialized = JSON.stringify(error.json);
    return serialized && serialized !== "{}" && serialized !== "null" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function redactCredentialPatterns(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth|code|credential|key|password|secret|token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|vca_[A-Za-z0-9_-]{8,})\b/g,
      "[REDACTED]",
    );
}

function redactPersistedText(value: string, secrets: Array<string | undefined>): string {
  return redactCredentialPatterns(redactSecrets(value, secrets));
}

function truncateBody(value: string): string {
  if (value.length <= RESPONSE_BODY_LIMIT) return value;
  return `${value.slice(0, RESPONSE_BODY_LIMIT)}...`;
}

export function formatVercelSandboxError(
  error: unknown,
  secrets: Array<string | undefined> = [],
): string {
  // The SDK ships separate ESM and CommonJS APIError constructors. Match its
  // response contract for display instead of relying on constructor identity.
  const response = vercelResponse(error);
  if (typeof response?.status !== "number") {
    return redactPersistedText(
      error instanceof Error ? error.message : "Vercel Sandbox request failed.",
      secrets,
    );
  }

  const details = record(error);
  const body = record(details?.json);
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
  const safeCode = code ? redactPersistedText(code, secrets).slice(0, 100) : undefined;
  const safeMessage = redactPersistedText(message || fallback, secrets).slice(0, 1000);
  const method = responseMethod(response);
  const url = responseUrl(response);
  const request = [method, url ? redactPersistedText(url, secrets) : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const rawBody = details ? responseBody(details) : undefined;
  const safeBody = rawBody
    ? truncateBody(redactPersistedText(redactJsonSecretValues(rawBody), secrets))
    : undefined;

  const summary = `Vercel Sandbox request failed (${status}${request ? ` ${request}` : ""}${safeCode ? `; ${safeCode}` : ""}): ${safeMessage}`;
  return safeBody ? `${summary}\nbody: ${safeBody}` : summary;
}

/** Text stored for a failed sandbox check or agent run. */
export function sandboxFailureText(
  error: unknown,
  secrets: Array<string | undefined> = [],
): string {
  if (isVercelSandboxApiError(error) || error instanceof Error) {
    return formatVercelSandboxError(error, secrets);
  }
  if (typeof error === "string" && error.trim()) return redactPersistedText(error, secrets);
  return "Vercel Sandbox request failed.";
}
