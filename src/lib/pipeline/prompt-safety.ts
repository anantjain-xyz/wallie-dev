import "server-only";

const MAX_UNTRUSTED_FIELD_LENGTH = 8000;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

const UNTRUSTED_CLOSE_TAGS = [
  "</linear_issue_title>",
  "</linear_issue_description>",
  "</previous_spec>",
  "</reviewer_feedback>",
];

function neutralizeBoundaries(value: string): string {
  let out = value;
  for (const tag of UNTRUSTED_CLOSE_TAGS) {
    const replacement = `[${tag.slice(1, -1)}]`;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), replacement);
  }
  return out;
}

export function sanitizeUntrusted(value: string): string {
  return neutralizeBoundaries(truncate(value, MAX_UNTRUSTED_FIELD_LENGTH));
}
