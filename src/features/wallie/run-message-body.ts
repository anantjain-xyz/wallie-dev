export type ParsedToolUseMessage = {
  payload: string;
  tool: string;
};

const TOOL_USE_TEMPLATE = /^\*\*Tool:\*\* ([^\n]+)\n\n```\n([\s\S]*)\n```\s*$/;

function prettyPrintJsonPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
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
