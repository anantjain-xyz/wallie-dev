import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

// Artifact bodies are agent-produced markdown — untrusted input. `react-markdown`
// never renders embedded raw HTML (it drops it rather than parsing it) and strips
// dangerous URL schemes by default; `rehype-sanitize` is layered on as an explicit,
// auditable allowlist so no script/style/event-handler content can reach the DOM.
// Markdown image syntax is additionally downgraded to a click-only link (see `img`
// below) so viewing an artifact can't auto-fetch attacker-controlled remote URLs.
const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const text = String(children ?? "");
    const isBlock = (className?.includes("language-") ?? false) || text.includes("\n");
    if (isBlock) {
      return <code className={cn("artifact-code-block", className)}>{children}</code>;
    }
    return <code className="artifact-inline-code">{children}</code>;
  },
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => <h1 className="artifact-heading-1">{children}</h1>,
  h2: ({ children }) => <h2 className="artifact-heading-2">{children}</h2>,
  h3: ({ children }) => <h3 className="artifact-heading-3">{children}</h3>,
  h4: ({ children }) => <h4 className="artifact-heading-4">{children}</h4>,
  hr: () => <hr className="my-4 border-border" />,
  // Artifact markdown is agent-produced and untrusted. An auto-loading <img>
  // would make the reviewer's browser fetch an attacker-controlled URL just by
  // viewing the artifact (a tracking/beacon vector the old raw <pre> never had),
  // so render image syntax as an explicit, click-only link instead.
  img: ({ src, alt }) => {
    const href = typeof src === "string" ? src : undefined;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        🖼 {alt?.trim() ? alt : (href ?? "image")}
      </a>
    );
  },
  li: ({ children }) => <li className="leading-6">{children}</li>,
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-6 text-foreground first:mt-0 last:mb-0">{children}</p>
  ),
  pre: ({ children }) => (
    <pre
      aria-label="Code block"
      className="artifact-pre first:mt-0 last:mb-0"
      role="region"
      tabIndex={0}
    >
      {children}
    </pre>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  table: ({ children }) => (
    <div
      aria-label="Table"
      className="artifact-table-scroll my-3 overflow-x-auto"
      role="region"
      tabIndex={0}
    >
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
  th: ({ children }) => (
    <th className="border border-border bg-control-muted px-2 py-1 font-semibold">{children}</th>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
};

export function MarkdownContent({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("artifact-content", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
