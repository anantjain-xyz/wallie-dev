import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  isSessionDetailHoverPointer,
  prefetchSessionDetailOnce,
  SessionDetailLink,
} from "@/features/sessions/components/session-detail-link";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) =>
    createElement("a", { ...props, "data-prefetch": String(prefetch) }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn() }),
}));

describe("SessionDetailLink", () => {
  it("disables automatic Link prefetch while preserving native anchor navigation", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailLink, { href: "/w/acme/sessions/7" }, "Open session"),
    );

    expect(html).toContain('href="/w/acme/sessions/7"');
    expect(html).toContain('data-prefetch="false"');
    expect(html).toContain("Open session");
  });

  it("recognizes hover-capable pointers without treating touch as hover intent", () => {
    expect(isSessionDetailHoverPointer("mouse")).toBe(true);
    expect(isSessionDetailHoverPointer("pen")).toBe(true);
    expect(isSessionDetailHoverPointer("touch")).toBe(false);
    expect(isSessionDetailHoverPointer("")).toBe(false);
  });
});

describe("prefetchSessionDetailOnce", () => {
  it("prefetches each href at most once for a mounted boundary", () => {
    const prefetchedHrefs = new Set<string>();
    const prefetch = vi.fn();

    prefetchSessionDetailOnce(prefetchedHrefs, "/w/acme/sessions/7", prefetch);
    prefetchSessionDetailOnce(prefetchedHrefs, "/w/acme/sessions/7", prefetch);
    prefetchSessionDetailOnce(prefetchedHrefs, "/w/acme/sessions/8", prefetch);

    expect(prefetch.mock.calls).toEqual([["/w/acme/sessions/7"], ["/w/acme/sessions/8"]]);
  });
});
