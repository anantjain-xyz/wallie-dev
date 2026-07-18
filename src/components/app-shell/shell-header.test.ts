import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreateSessionDialogLoading,
  preloadCreateSessionDialogOnce,
  ShellHeader,
} from "@/components/app-shell/shell-header";
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
        viewerId: "user-1",
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
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
        workspace,
        workspaceAvatarUrl: null,
      }),
    );

    expect(html).toContain("New session");
    expect(html).not.toContain("Resume setup");
    expect(html).not.toContain("Loading session form…");
  });

  it("renders the topbar theme toggle as an accessible icon button", () => {
    const html = renderToStaticMarkup(
      createElement(ShellHeader, {
        navItems,
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
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
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
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
        onboarding: { currentStep: "verify", status: "completed" },
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
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

describe("create-session dialog loading", () => {
  it("waits for the client overlay root before rendering portal content", () => {
    const html = renderToStaticMarkup(createElement(CreateSessionDialogLoading));

    expect(html).toBe("");
  });

  it("deduplicates preloads for one shell mount", () => {
    const startedKey = { current: null };
    const preloadSessionRepositories = vi.fn(async () => ({
      defaultGithubRepositoryId: null,
      repositoryOptions: [],
    }));
    const load = vi.fn(async () => ({ preloadSessionRepositories }));
    const input = { userId: "user-1", workspaceId: "workspace-1" };

    preloadCreateSessionDialogOnce(startedKey, input, load);
    preloadCreateSessionDialogOnce(startedKey, input, load);

    expect(load).toHaveBeenCalledTimes(1);
    return vi.waitFor(() => expect(preloadSessionRepositories).toHaveBeenCalledWith(input));
  });

  it("resets the guard so a failed preload can retry", async () => {
    const startedKey = { current: null };
    const preloadSessionRepositories = vi.fn(async () => {
      throw new Error("repositories failed");
    });
    const load = vi.fn(async () => ({ preloadSessionRepositories }));
    const input = { userId: "user-1", workspaceId: "workspace-1" };

    preloadCreateSessionDialogOnce(startedKey, input, load);
    await vi.waitFor(() => expect(startedKey.current).toBeNull());

    preloadCreateSessionDialogOnce(startedKey, input, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("starts a separate preload after the workspace changes", async () => {
    const startedKey = { current: null };
    const preloadSessionRepositories = vi.fn(async () => ({
      defaultGithubRepositoryId: null,
      repositoryOptions: [],
    }));
    const load = vi.fn(async () => ({ preloadSessionRepositories }));

    preloadCreateSessionDialogOnce(
      startedKey,
      { userId: "user-1", workspaceId: "workspace-1" },
      load,
    );
    preloadCreateSessionDialogOnce(
      startedKey,
      { userId: "user-1", workspaceId: "workspace-2" },
      load,
    );

    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(preloadSessionRepositories).toHaveBeenCalledTimes(2));
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
