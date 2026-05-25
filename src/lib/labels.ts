const ACRONYM_LABELS = new Map<string, string>([
  ["api", "API"],
  ["chatgpt", "ChatGPT"],
  ["cli", "CLI"],
  ["codex", "Codex"],
  ["gpt", "GPT"],
  ["github", "GitHub"],
  ["html", "HTML"],
  ["id", "ID"],
  ["json", "JSON"],
  ["linear", "Linear"],
  ["openai", "OpenAI"],
  ["pr", "PR"],
  ["ui", "UI"],
  ["url", "URL"],
  ["wallie", "Wallie"],
]);

export function formatSentenceCaseLabel(value: string): string {
  const words = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .flatMap((word) =>
      ACRONYM_LABELS.has(word.toLowerCase())
        ? word
        : word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "),
    )
    .filter(Boolean);

  return words
    .map((word, index) => {
      const normalized = word.toLowerCase();
      const acronym = ACRONYM_LABELS.get(normalized);
      if (acronym) return acronym;

      if (index === 0) {
        return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
      }

      return normalized;
    })
    .join(" ");
}
