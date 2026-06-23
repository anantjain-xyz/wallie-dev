import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShellHeader } from "@/components/app-shell/shell-header";
import { normalizeTheme, resolveInitialTheme } from "@/components/app-shell/theme-toggle";
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
  CreateSessionDialog: ({
    defaultGithubRepositoryId,
    open,
  }: {
    defaultGithubRepositoryId: string | null;
    open: boolean;
  }) =>
    open
      ? createElement(
          "div",
          {
            "data-default-repository-id": defaultGithubRepositoryId ?? "",
            "data-dialog-state": "open",
          },
          "Create dialog",
        )
      : null,
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
        defaultSessionGithubRepositoryId: "repo-1",
        onboarding: { currentStep: "repository", status: "in_progress" },
        viewerEmail: "owner@example.com",
        workspace,
        workspaceAvatarUrl: null,
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
        defaultSessionGithubRepositoryId: "repo-1",
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        workspace,
        workspaceAvatarUrl: null,
      }),
    );

    expect(html).toContain("New session");
    expect(html).not.toContain("Resume setup");
    expect(html).toContain('data-dialog-state="open"');
    expect(html).toContain('data-default-repository-id="repo-1"');
  });

  it("renders the topbar theme toggle as an accessible icon button", () => {
    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        defaultSessionGithubRepositoryId: null,
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        workspace,
        workspaceAvatarUrl: null,
      }),
    );

    expect(html).toContain('aria-label="Switch to dark mode"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="Switch to dark mode"');
  });

  it("shows the workspace identity beside the Wallie wordmark", () => {
    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        defaultSessionGithubRepositoryId: null,
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        workspace,
        workspaceAvatarUrl: null,
      }),
    );

    expect(html).toContain("Wallie");
    expect(html).toContain("Acme Corp");
    // No avatar URL → initial fallback badge.
    expect(html).toContain(">A<");
  });

  it("renders an account menu exposing the signed-in email and sign-out", () => {
    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        defaultSessionGithubRepositoryId: null,
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        workspace,
        workspaceAvatarUrl: null,
      }),
    );

    // The signed-in email is exposed on the menu trigger; the menu panel
    // (with the sign-out form) mounts on open, which the AccountMenu test covers.
    expect(html).toContain('aria-label="Account: owner@example.com"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("theme helpers", () => {
  it("normalizes only supported stored theme values", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBeNull();
    expect(normalizeTheme(null)).toBeNull();
  });

  it("resolves the first theme from storage before system preference", () => {
    expect(resolveInitialTheme("dark", false)).toBe("dark");
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(undefined, false)).toBe("light");
  });
});
