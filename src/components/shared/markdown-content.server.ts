import "server-only";

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

type HtmlNode = {
  children?: HtmlNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
};

const classesByTag: Record<string, string> = {
  a: "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent",
  blockquote: "my-3 border-l-2 border-border pl-3 text-muted italic",
  em: "italic",
  h1: "artifact-heading-1",
  h2: "artifact-heading-2",
  h3: "artifact-heading-3",
  h4: "artifact-heading-4",
  hr: "my-4 border-border",
  li: "leading-6",
  ol: "my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0",
  p: "my-2 leading-6 text-foreground first:mt-0 last:mb-0",
  pre: "artifact-pre first:mt-0 last:mb-0",
  strong: "font-semibold text-foreground",
  table: "w-full border-collapse text-left text-[13px]",
  td: "border border-border px-2 py-1 align-top",
  th: "border border-border bg-control-muted px-2 py-1 font-semibold",
  ul: "my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0",
};

function classNames(value: string) {
  return value.split(" ").filter(Boolean);
}

function textContent(node: HtmlNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function styleNode(node: HtmlNode, parent?: HtmlNode, index = -1) {
  for (const [childIndex, child] of (node.children ?? []).entries()) {
    styleNode(child, node, childIndex);
  }

  if (node.type !== "element" || !node.tagName) return;
  node.properties ??= {};
  const tagClass = classesByTag[node.tagName];
  if (tagClass) node.properties.className = classNames(tagClass);

  if (node.tagName === "a") {
    node.properties.target = "_blank";
    node.properties.rel = ["noopener", "noreferrer", "nofollow"];
  }

  if (node.tagName === "code") {
    const inherited = Array.isArray(node.properties.className)
      ? node.properties.className.filter((value): value is string => typeof value === "string")
      : [];
    node.properties.className =
      parent?.tagName === "pre" ? ["artifact-code-block", ...inherited] : ["artifact-inline-code"];
  }

  if (node.tagName === "pre") {
    node.properties.ariaLabel = "Code block";
    node.properties.role = "group";
    node.properties.tabIndex = 0;
  }

  // Preserve the existing click-only image policy: no untrusted remote resource
  // is fetched until the reviewer explicitly opens the sanitized link.
  if (node.tagName === "img" && parent?.children && index >= 0) {
    const href = typeof node.properties.src === "string" ? node.properties.src : undefined;
    const alt = typeof node.properties.alt === "string" ? node.properties.alt.trim() : "";
    parent.children[index] = {
      children: [{ type: "text", value: `🖼 ${alt || href || "image"}` }],
      properties: {
        className: classNames(classesByTag.a!),
        href,
        rel: ["noopener", "noreferrer", "nofollow"],
        target: "_blank",
      },
      tagName: "a",
      type: "element",
    };
  }

  if (node.tagName === "table" && parent?.children && index >= 0) {
    parent.children[index] = {
      children: [node],
      properties: {
        ariaLabel: "Table",
        className: ["artifact-table-scroll", "my-3", "overflow-x-auto"],
        role: "region",
        tabIndex: 0,
      },
      tagName: "div",
      type: "element",
    };
  }

  // Prevent an empty link label after sanitization strips a dangerous href.
  if (node.tagName === "a" && textContent(node).length === 0) {
    node.children = [{ type: "text", value: "link" }];
  }
}

function styleMarkdownHtml() {
  return (tree: unknown) => styleNode(tree as HtmlNode);
}

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const rendered = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(styleMarkdownHtml)
    .use(rehypeStringify)
    .process(markdown);

  return `<div class="artifact-content">${String(rendered)}</div>`;
}
