import "server-only";

import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import type { SanitizedMarkdownHtml } from "@/components/shared/markdown-content";

type HtmlNode = {
  children?: HtmlNode[];
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
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

const UNAVAILABLE_EVIDENCE =
  "This evidence was not retained with this artifact. Temporary sandbox files cannot be opened after the run.";

/** A conservative prefilter; Markdown can percent- or entity-encode the scheme. */
export function mayContainEvidenceLinks(markdown: string): boolean {
  return /wallie-evidence:|%|&/i.test(markdown);
}

function decodeUrl(value: string): string {
  // Nested escaping must not turn a filesystem destination into a website link.
  for (;;) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) return value;
      value = decoded;
    } catch {
      return value;
    }
  }
}

function isSandboxPath(href: string): boolean {
  let value = decodeUrl(href).trim().replaceAll("\\", "/");
  if (/^(?:file|sandbox):/i.test(value) || /^[a-z]:\//i.test(value)) return true;

  let absolutePath = value.startsWith("/");
  if (/^(?:https?:)?\/\//i.test(value)) {
    try {
      const url = new URL(value, "https://wallie.dev");
      if (!["wallie.dev", "www.wallie.dev"].includes(url.hostname.replace(/\.$/, ""))) return false;
      value = decodeUrl(url.pathname);
      absolutePath = true;
    } catch {
      return false;
    }
  }

  // Resolve dot segments before checking known sandbox roots. Relative repository
  // paths (including home/... and ../docs/...) remain ordinary document links.
  let path: string;
  try {
    // A same-host pathname beginning with // is still a path, never a new host.
    path = new URL(value.replace(/\/+/g, "/"), "https://wallie.dev/").pathname;
  } catch {
    return false;
  }
  if (/^\/vercel\/sandbox(?:\/|$)/i.test(path)) return true;
  return (
    absolutePath &&
    /^\/(?:home|Users|root|tmp|private\/(?:tmp|var)|var|workspace|workspaces|mnt\/data)(?:\/|$)/i.test(
      path,
    )
  );
}

/** Rewrite only server-resolved evidence identities, then sanitize the resulting URLs. */
function resolveEvidenceLinks(links: ReadonlyMap<string, string>) {
  function visit(node: HtmlNode) {
    for (const child of node.children ?? []) visit(child);
    if (node.type !== "element" || !["a", "img"].includes(node.tagName ?? "")) return;
    const property = node.tagName === "img" ? "src" : "href";
    const href = node.properties?.[property];
    if (typeof href !== "string") return;
    const decodedHref = decodeUrl(href).trim();
    const evidence = /^wallie-evidence:/i.test(decodedHref);
    const key = evidence ? `wallie-evidence:${decodedHref.slice("wallie-evidence:".length)}` : null;
    if (key && links.has(key)) {
      node.properties![property] = links.get(key);
      return;
    }
    if (!evidence && !isSandboxPath(href)) return;
    if (node.tagName === "img") {
      const alt = node.properties?.alt;
      node.children = [
        { type: "text", value: `🖼 ${typeof alt === "string" && alt ? alt : "image"}` },
      ];
    }
    node.tagName = "span";
    node.properties = { title: UNAVAILABLE_EVIDENCE };
    node.children = [...(node.children ?? []), { type: "text", value: " (Evidence unavailable)" }];
  }
  return (tree: unknown) => visit(tree as HtmlNode);
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

  if (node.tagName === "span" && node.properties.title === UNAVAILABLE_EVIDENCE) {
    node.properties.className = ["text-muted", "break-words"];
    node.properties.ariaDisabled = "true";
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

  // Never auto-load agent-controlled image URLs. Images become explicit links
  // that a reviewer can choose to open.
  if (node.tagName === "img" && parent?.children && index >= 0) {
    const href = typeof node.properties.src === "string" ? node.properties.src : undefined;
    const alt = typeof node.properties.alt === "string" ? node.properties.alt.trim() : "";
    parent.children[index] = {
      children: [{ type: "text", value: `🖼 ${alt || href || "image"}`, position: node.position }],
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
    node.children = [{ type: "text", value: "link", position: node.position }];
  }
}

/** Attach only server-derived source coordinates, after sanitization. */
function reviewSourcePositions(source: string) {
  const offsets = new Map<number, number>();
  let utf16 = 0;
  let points = 0;
  for (const point of source) {
    offsets.set(utf16, points++);
    utf16 += point.length;
  }
  offsets.set(utf16, points);
  function visit(node: HtmlNode) {
    for (let index = 0; index < (node.children?.length ?? 0); index++) {
      const child = node.children![index]!;
      if (child.type === "text" && child.value) {
        let start = child.position?.start.offset;
        let end = child.position?.end.offset;
        // Code nodes create synthetic text children. Only a unique exact match
        // can supply offsets for selecting part of that rendered text.
        if (start === undefined && node.tagName === "code") {
          const parentStart = node.position?.start.offset;
          const parentEnd = node.position?.end.offset;
          if (parentStart !== undefined && parentEnd !== undefined) {
            const raw = source.slice(parentStart, parentEnd);
            const found = raw.indexOf(child.value);
            if (found >= 0 && raw.indexOf(child.value, found + 1) < 0) {
              start = parentStart + found;
              end = start + child.value.length;
            } else {
              start = parentStart;
              end = parentEnd;
            }
          }
        }
        if (
          start !== undefined &&
          end !== undefined &&
          start < end &&
          offsets.has(start) &&
          offsets.has(end)
        ) {
          node.children![index] = {
            type: "element",
            tagName: "span",
            properties:
              source.slice(start, end) === child.value
                ? { dataReviewTextStart: offsets.get(start), dataReviewTextEnd: offsets.get(end) }
                : {
                    dataReviewRenderedStart: offsets.get(start),
                    dataReviewRenderedEnd: offsets.get(end),
                  },
            children: [child],
          };
        }
      } else visit(child);
    }
  }
  return (tree: unknown) => visit(tree as HtmlNode);
}

function styleMarkdownHtml() {
  return (tree: unknown) => styleNode(tree as HtmlNode);
}

export type RenderedMarkdown = Readonly<{
  bodyHtml: SanitizedMarkdownHtml;
  html: string;
}>;

/** The only parsing, GFM, sanitization, and styling pipeline for artifact Markdown. */
export function renderMarkdown(
  markdown: string,
  reviewSource = false,
  evidenceLinks: ReadonlyMap<string, string> = new Map(),
): RenderedMarkdown {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(resolveEvidenceLinks, evidenceLinks)
    .use(rehypeSanitize)
    .use(styleMarkdownHtml);
  if (reviewSource) processor.use(reviewSourcePositions, markdown);
  const rendered = processor.use(rehypeStringify).processSync(markdown);
  const bodyHtml = String(rendered) as SanitizedMarkdownHtml;

  return {
    bodyHtml,
    html: `<div class="artifact-content">${bodyHtml}</div>`,
  };
}

/** Preserve the artifact API's existing full-document-fragment contract. */
export function renderMarkdownToHtml(
  markdown: string,
  reviewSource = false,
  evidenceLinks: ReadonlyMap<string, string> = new Map(),
): string {
  return renderMarkdown(markdown, reviewSource, evidenceLinks).html;
}
