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
  const parsed = matchToolUseMessage(messageMd);
  return parsed ? { ...parsed, payload: prettyPrintJsonPayload(parsed.payload) } : null;
}

function matchToolUseMessage(messageMd: string): ParsedToolUseMessage | null {
  const match = TOOL_USE_TEMPLATE.exec(messageMd.replace(/\r\n/g, "\n"));
  if (!match) {
    return null;
  }

  const tool = match[1]?.trim() ?? "";
  if (!tool) {
    return null;
  }

  return {
    payload: match[2] ?? "",
    tool,
  };
}

export type ToolActivitySummary = {
  category: "read" | "search" | "list" | null;
  title: string;
  target: string;
};

/** Derive display text only. A persisted tool input does not prove execution or success. */
export function summarizeToolUse(messageMd: string): ToolActivitySummary {
  const parsed = matchToolUseMessage(messageMd);
  if (!parsed) return { category: null, title: "Tool use", target: "" };

  let input: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(parsed.payload);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      input = value as Record<string, unknown>;
    }
  } catch {
    // Unknown/non-JSON input remains available in the disclosure.
  }
  const field = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
    }
    return "";
  };
  const name = parsed.tool.split(/[./]/).at(-1)?.toLowerCase().replace(/[_-]/g, "");
  const path = () => field("file_path", "filePath", "path", "filename");
  switch (name) {
    case "read":
    case "readfile":
      return { category: "read", title: "Read", target: path() };
    case "grep":
    case "glob":
    case "search":
    case "searchfiles":
      return { category: "search", title: "Search", target: field("pattern", "query", "regex") };
    case "ls":
    case "list":
    case "listdirectory":
      return { category: "list", title: "List", target: path() };
    case "bash":
    case "shell":
    case "execcommand":
      return { category: null, title: "Shell", target: field("command", "cmd") };
    case "edit":
    case "editfile":
    case "write":
    case "writefile":
      return { category: null, title: name.startsWith("write") ? "Write" : "Edit", target: path() };
    case "applypatch":
      return { category: null, title: "Apply patch", target: "" };
    default:
      return {
        category: null,
        title: parsed.tool,
        target: field("description", "query", "url", "file_path", "filePath", "path", "name"),
      };
  }
}
