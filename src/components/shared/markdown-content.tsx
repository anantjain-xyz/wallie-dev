import { cn } from "@/lib/utils";

declare const sanitizedMarkdownHtml: unique symbol;

export type SanitizedMarkdownHtml = string & {
  readonly [sanitizedMarkdownHtml]: "SanitizedMarkdownHtml";
};

/**
 * Present HTML produced by the canonical server Markdown renderer.
 *
 * Callers must pass only `bodyHtml` returned by `renderMarkdown`; agent-authored
 * Markdown must never be converted to HTML in the browser or passed through raw.
 */
export function MarkdownContent({
  html,
  className,
}: {
  html: SanitizedMarkdownHtml;
  className?: string;
}) {
  return (
    <div className={cn("artifact-content", className)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
