const LINEAR_ISSUE_PATH_RE = /\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\/|$)/i;

export function extractLinearIssueId(value: string): string | null {
  try {
    const url = new URL(value);
    const isLinearHost =
      url.hostname.toLowerCase() === "linear.app" ||
      url.hostname.toLowerCase().endsWith(".linear.app");

    if (!isLinearHost || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return null;
    }

    return url.pathname.match(LINEAR_ISSUE_PATH_RE)?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}
