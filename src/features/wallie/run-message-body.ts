export type ParsedToolUseMessage = {
  payload: string;
  tool: string;
};

const TOOL_USE_TEMPLATE = /^\*\*Tool:\*\* ([^\n]+)\n\n```\n([\s\S]*)\n```\s*$/;
const JSON_WHITESPACE = /[ \t\n\r]/;

function isJsonWhitespace(char: string | undefined): boolean {
  return char !== undefined && JSON_WHITESPACE.test(char);
}

function isJsonLiteralEnd(char: string | undefined): boolean {
  return (
    char === undefined ||
    isJsonWhitespace(char) ||
    char === "," ||
    char === "}" ||
    char === "]" ||
    char === ":"
  );
}

/**
 * Pretty-print JSON while copying number (and other) literals from the source
 * so values outside `Number.MAX_SAFE_INTEGER` are not rounded by `JSON.parse`.
 */
function prettyPrintJsonPayload(payload: string): string {
  const source = payload.trim();
  try {
    JSON.parse(source);
  } catch {
    return payload;
  }

  try {
    return formatJsonPreservingLiterals(source);
  } catch {
    return payload;
  }
}

function formatJsonPreservingLiterals(source: string): string {
  let i = 0;
  let depth = 0;
  let out = "";

  const skipWs = () => {
    while (i < source.length && isJsonWhitespace(source[i])) {
      i += 1;
    }
  };

  const readString = (): string => {
    const start = i;
    i += 1;
    while (i < source.length) {
      const char = source[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      i += 1;
      if (char === '"') {
        return source.slice(start, i);
      }
    }
    throw new Error("unterminated string");
  };

  const readLiteral = (): string => {
    const start = i;
    while (i < source.length && !isJsonLiteralEnd(source[i])) {
      i += 1;
    }
    if (i === start) {
      throw new Error("expected literal");
    }
    return source.slice(start, i);
  };

  skipWs();
  while (i < source.length) {
    skipWs();
    if (i >= source.length) {
      break;
    }

    const char = source[i];
    if (char === "{" || char === "[") {
      out += char;
      i += 1;
      skipWs();
      const closing = char === "{" ? "}" : "]";
      if (source[i] === closing) {
        out += closing;
        i += 1;
      } else {
        depth += 1;
        out += `\n${"  ".repeat(depth)}`;
      }
      continue;
    }

    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      out += `\n${"  ".repeat(depth)}${char}`;
      i += 1;
      continue;
    }

    if (char === ",") {
      out += `,\n${"  ".repeat(depth)}`;
      i += 1;
      continue;
    }

    if (char === ":") {
      out += ": ";
      i += 1;
      continue;
    }

    if (char === '"') {
      out += readString();
      continue;
    }

    out += readLiteral();
  }

  return out;
}

/**
 * Parse the persisted `tool_use` markdown template:
 * `**Tool:** <name>` plus a fenced payload. The payload match is greedy so an
 * inner fence in file contents does not steal the wrapper closer.
 */
export function parseToolUseMessage(messageMd: string): ParsedToolUseMessage | null {
  const match = TOOL_USE_TEMPLATE.exec(messageMd.replace(/\r\n/g, "\n"));
  if (!match) {
    return null;
  }

  const tool = match[1]?.trim() ?? "";
  if (!tool) {
    return null;
  }

  return {
    payload: prettyPrintJsonPayload(match[2] ?? ""),
    tool,
  };
}
