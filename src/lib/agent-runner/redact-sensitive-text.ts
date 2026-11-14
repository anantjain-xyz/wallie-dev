const REDACTED = "[redacted]";
const SECRET_KEY_SOURCE = String.raw`(?:access[_-]?key|access[_-]?token|api[_-]?key|client[_-]?secret|credential|password|private[_-]?key|secret|token)`;
const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_SOURCE, "i");
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*?\2`,
  "gi",
);

const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(?!["'])[^\r\n;,]+`,
  "gi",
);

function redactJsonSecretFields(message: string): string {
  let redacted = "";
  let lastWritten = 0;
  let index = 0;

  while (index < message.length) {
    const key = readQuotedValue(message, index);
    if (!key) {
      index += 1;
      continue;
    }

    let cursor = skipWhitespace(message, key.end);
    if (message[cursor] !== ":") {
      index = key.end;
      continue;
    }

    if (!SECRET_KEY_PATTERN.test(key.value)) {
      index = key.end;
      continue;
    }

    cursor += 1;
    const valueStart = skipWhitespace(message, cursor);
    const valueEnd = findJsonValueEnd(message, valueStart);
    const redactionQuote = message[valueStart] === "'" ? "'" : `"`;

    redacted += message.slice(lastWritten, cursor);
    redacted += ` ${redactionQuote}${REDACTED}${redactionQuote}`;
    lastWritten = valueEnd;
    index = valueEnd;
  }

  return redacted + message.slice(lastWritten);
}

function readQuotedValue(
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

function skipWhitespace(message: string, start: number): number {
  let index = start;
  while (index < message.length && /\s/.test(message[index]!)) {
    index += 1;
  }
  return index;
}

function findJsonValueEnd(message: string, start: number): number {
  const first = message[start];
  if (first === `"` || first === "'") {
    return readQuotedValue(message, start)?.end ?? message.length;
  }

  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < message.length) {
      const char = message[index]!;
      if (char === `"` || char === "'") {
        index = readQuotedValue(message, index)?.end ?? message.length;
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

export function redactRunSensitiveText(message: string): string {
  return redactJsonSecretFields(message)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth|code|credential|key|password|secret|token)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(QUOTED_SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED}$2`)
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, REDACTED)
    .replace(UNQUOTED_SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sb_[A-Za-z0-9_-]{16,}|vca_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
      REDACTED,
    );
}

const QUOTED_JSON_FIELD = /("(?:\\.|[^"\\])*"\s*:\s*)("(?:\\.|[^"\\])*")/g;

function redactToolString(message: string, encodedDepth: number): string {
  // Shell arguments can contain JSON fragments even when the whole string isn't JSON.
  const sanitized = message.replace(
    QUOTED_JSON_FIELD,
    (field: string, key: string, value: string) => {
      try {
        const name: string = JSON.parse(key.trimEnd().slice(0, -1));
        const decoded: string = JSON.parse(value);
        if (SECRET_KEY_PATTERN.test(name)) return `${key}${JSON.stringify(REDACTED)}`;
        const redacted = redactRunToolText(decoded, encodedDepth + 1);
        return redacted === decoded ? field : `${key}${JSON.stringify(redacted)}`;
      } catch {
        return field;
      }
    },
  );
  return redactRunSensitiveText(sanitized);
}

/** Redact decoded tool fields before their JSON escapes can hide credentials. */
export function redactRunToolText(message: string, encodedDepth = 0): string {
  if (encodedDepth >= 8) return REDACTED;
  const first = message.trimStart()[0];
  if (first !== "{" && first !== "[" && first !== '"')
    return redactToolString(message, encodedDepth);
  let decoded: unknown;
  try {
    decoded = JSON.parse(message);
  } catch {
    return redactToolString(message, encodedDepth);
  }
  try {
    return JSON.stringify(decoded, (key: string, value: unknown) => {
      if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
      return typeof value === "string" ? redactRunToolText(value, encodedDepth + 1) : value;
    });
  } catch {
    // Deep provider data may exceed the serializer stack. Keep no raw fallback.
    return REDACTED;
  }
}
