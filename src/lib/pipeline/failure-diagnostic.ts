export const RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH = 1000;
export const VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH = 4_096;
const REDACTED_RUN_DIAGNOSTIC_VALUE = "[redacted]";
const RUN_FAILURE_SECRET_KEY_SOURCE = String.raw`(?:access[_-]?key|access[_-]?token|api[_-]?key|client[_-]?secret|credential|password|private[_-]?key|secret|token)`;
const RUN_FAILURE_SECRET_KEY_PATTERN = new RegExp(RUN_FAILURE_SECRET_KEY_SOURCE, "i");
const RUN_FAILURE_QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${RUN_FAILURE_SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*?\2`,
  "gi",
);

const RUN_FAILURE_UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${RUN_FAILURE_SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(?!["'])[^\r\n;,]+`,
  "gi",
);

function redactJsonSecretFields(message: string): string {
  let redacted = "";
  let lastWritten = 0;
  let index = 0;

  while (index < message.length) {
    const key = readQuotedDiagnosticValue(message, index);
    if (!key) {
      index += 1;
      continue;
    }

    let cursor = skipDiagnosticWhitespace(message, key.end);
    if (message[cursor] !== ":") {
      index = key.end;
      continue;
    }

    if (!RUN_FAILURE_SECRET_KEY_PATTERN.test(key.value)) {
      index = key.end;
      continue;
    }

    cursor += 1;
    const valueStart = skipDiagnosticWhitespace(message, cursor);
    const valueEnd = findJsonDiagnosticValueEnd(message, valueStart);
    const redactionQuote = message[valueStart] === "'" ? "'" : `"`;

    redacted += message.slice(lastWritten, cursor);
    redacted += ` ${redactionQuote}${REDACTED_RUN_DIAGNOSTIC_VALUE}${redactionQuote}`;
    lastWritten = valueEnd;
    index = valueEnd;
  }

  return redacted + message.slice(lastWritten);
}

function readQuotedDiagnosticValue(
  message: string,
  start: number,
): { end: number; quote: `"` | "'"; value: string } | null {
  const quote = message[start];
  if (quote !== `"` && quote !== "'") return null;

  let value = "";
  for (let index = start + 1; index < message.length; index += 1) {
    const char = message[index]!;
    if (char === "\\") {
      const escaped = message[index + 1];
      if (escaped) {
        value += escaped;
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return { end: index + 1, quote, value };
    }
    value += char;
  }

  return null;
}

function skipDiagnosticWhitespace(message: string, start: number): number {
  let index = start;
  while (index < message.length && /\s/.test(message[index]!)) {
    index += 1;
  }
  return index;
}

function findJsonDiagnosticValueEnd(message: string, start: number): number {
  const first = message[start];
  if (first === `"` || first === "'") {
    return readQuotedDiagnosticValue(message, start)?.end ?? message.length;
  }

  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < message.length) {
      const char = message[index]!;
      if (char === `"` || char === "'") {
        index = readQuotedDiagnosticValue(message, index)?.end ?? message.length;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          return index + 1;
        }
      }
      index += 1;
    }
    return message.length;
  }

  let index = start;
  while (index < message.length && !/[\r\n,}\]]/.test(message[index]!)) {
    index += 1;
  }
  return index;
}

export function sanitizeRunFailureDiagnostic(
  message: string,
  maxLength = RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH,
): string {
  const fallback = "Stage generation failed";
  let sanitized = message.trim() || fallback;

  sanitized = redactJsonSecretFields(sanitized);

  sanitized = sanitized
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}@`,
    )
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth|code|credential|key|password|secret|token)=)[^&\s]+/gi,
      `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}`,
    )
    .replace(RUN_FAILURE_QUOTED_SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED_RUN_DIAGNOSTIC_VALUE}$2`)
    .replace(
      /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
      REDACTED_RUN_DIAGNOSTIC_VALUE,
    )
    .replace(RUN_FAILURE_UNQUOTED_SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, `$1 ${REDACTED_RUN_DIAGNOSTIC_VALUE}`)
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sb_[A-Za-z0-9_-]{16,}|vca_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
      REDACTED_RUN_DIAGNOSTIC_VALUE,
    );

  if (sanitized.length > maxLength) {
    return `${sanitized.slice(0, maxLength - 3)}...`;
  }

  return sanitized;
}
