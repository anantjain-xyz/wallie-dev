/** Isolated browser fixtures: no session or workspace writes. */
export const richReviewSource = [
  "# Implementation complete",
  "",
  "Repeat 🚀 café é **retry** and `code`.",
  "",
  "Repeat 🚀 café é **retry** and `code`.",
  "",
  "```ts",
  "const rocket = '🚀';",
  "```",
].join("\n");

export function reviewFixtureSource(kind: string | string[] | undefined, version: number) {
  if (kind === "rich") return richReviewSource;
  if (kind === "transformed") return "café &amp; tea";
  if (kind === "oversized") return "x".repeat(10001);
  return `# Implementation complete\n\nVersion ${version} is ready for review.`;
}
