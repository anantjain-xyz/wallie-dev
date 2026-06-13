"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

// Artifact bodies are agent-produced markdown — untrusted input. `react-markdown`
// never renders embedded raw HTML (it treats it as text) and strips dangerous URL
// schemes by default; `rehype-sanitize` is layered on as an explicit, auditable
// allowlist so no script/style/event-handler content can reach the DOM.
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
      return <code className={cn("font-mono", className)}>{children}</code>;
    }
    return (
      <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
        {children}
      </code>
    );
  },
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-[16px] font-semibold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-[14px] font-semibold text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[13px] font-semibold text-foreground first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[12px] font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  hr: () => <hr className="my-4 border-border" />,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-6 text-foreground first:mt-0 last:mb-0">{children}</p>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-auto rounded-[4px] border border-border bg-background p-3 text-[12px] leading-5 first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12px]">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
  th: ({ children }) => (
    <th className="border border-border bg-surface-muted px-2 py-1 font-semibold">{children}</th>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
};

export function MarkdownContent({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-[13px] text-foreground", className)}>
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
