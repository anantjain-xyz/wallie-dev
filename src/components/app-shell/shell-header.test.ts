import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShellHeader } from "@/components/app-shell/shell-header";
import { getWorkspaceNavItems } from "@/lib/routes";

const mocked = vi.hoisted(() => ({
  pathname: "/w/acme-corp",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useRouter: () => ({ replace: mocked.replace }),
  useSearchParams: () => mocked.searchParams,
}));

vi.mock("@/features/sessions/create-session-dialog", () => ({
  CreateSessionDialog: ({ open }: { open: boolean }) =>
    open ? createElement("div", { "data-dialog-state": "open" }, "Create dialog") : null,
}));

const workspace = { id: "workspace-1", name: "Acme Corp", slug: "acme-corp" };
const navItems = getWorkspaceNavItems(workspace.slug);

describe("ShellHeader", () => {
  afterEach(() => {
    mocked.pathname = "/w/acme-corp";
    mocked.replace.mockClear();
    mocked.searchParams = new URLSearchParams();
  });

  it("replaces New session with Resume setup while onboarding is incomplete", () => {
    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        onboarding: { currentStep: "repository", status: "in_progress" },
        viewerEmail: "owner@example.com",
        workspace,
      }),
    );

    expect(html).toContain('href="/w/acme-corp/onboarding"');
    expect(html).toContain("Resume setup");
    expect(html).not.toContain("New session");
    expect(html).not.toContain("data-dialog-state");
  });

  it("keeps New session available after onboarding is complete", () => {
    mocked.searchParams = new URLSearchParams("create=1");

    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        workspace,
      }),
    );

    expect(html).toContain("New session");
    expect(html).not.toContain("Resume setup");
    expect(html).toContain('data-dialog-state="open"');
  });
});
