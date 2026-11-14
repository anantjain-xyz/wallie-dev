import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";

export const RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH = 1000;
export const VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH = 4_096;

export function sanitizeRunFailureDiagnostic(
  message: string,
  maxLength = RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH,
): string {
  const fallback = "Stage generation failed";
  const sanitized = redactRunSensitiveText(message.trim() || fallback);

  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength - 3)}...`;
  }

  return sanitized;
}
