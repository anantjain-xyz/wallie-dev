// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CreateSessionDialogLoading,
  CreateSessionDialogRequest,
  prefetchShellNavHrefOnIntent,
  preloadCreateSessionDialogOnce,
  ShellHeader,
} from "@/components/app-shell/shell-header";
import { normalizeTheme, resolveInitialTheme } from "@/components/app-shell/theme-toggle";
import {
  matchWorkspaceLocation,
  readFactoryRequest,
  resolveWorkspaceScope,
  workspaceScopeLocationKey,
} from "@/components/app-shell/workspace-location";
import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const mocked = vi.hoisted(() => ({
  pathname: "/w/acme-corp",
  prefetch: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useRouter: () => ({ prefetch: mocked.prefetch, replace: mocked.replace }),
  useSearchParams: () => mocked.searchParams,
}));

const clientMocks = vi.hoisted(() => ({
  createSessionFromClient: vi.fn(),
  deletePendingSessionAttachmentFromClient: vi.fn().mockResolvedValue(undefined),
  loadSessionCreationFactoriesFromClient: vi.fn().mockResolvedValue([]),
  loadSessionRepositoryOptionsFromClient: vi.fn(),
  uploadSessionAttachmentFromClient: vi.fn(),
}));

vi.mock("@/features/sessions/client", () => clientMocks);

const workspace = { id: "workspace-1", name: "Acme Corp", slug: "acme-corp" };
const creationFactory = { id: "factory-1", name: "Default Factory" };
const defaultOptions = [
  { ...creationFactory, isDefault: true, status: "active", canManage: true },
  { id: "other-factory", name: "Mobile", isDefault: false, status: "active" },
] satisfies FactorySelectionOption[];

type HeaderProps = Omit<Parameters<typeof ShellHeader>[0], "children">;

function createShellProps(props: Partial<HeaderProps>): HeaderProps {
  return {
    factories: defaultOptions,
    onboarding: { currentStep: "verify", status: "completed" },
    viewerAvatarUrl: null,
    viewerEmail: "owner@example.com",
    viewerId: "user-1",
    workspace,
    workspaceAvatarUrl: null,
    ...props,
  };
}

function renderShell(props: Partial<HeaderProps> = {}) {
  return renderToStaticMarkup(createElement(ShellHeader, createShellProps(props), "Page body"));
}

function shellElement(props: Partial<HeaderProps> = {}) {
  const header = createShellProps(props);
  const location = matchWorkspaceLocation(mocked.pathname, header.workspace.slug);
  const factories = header.factories ?? [];
  const query = readFactoryRequest(mocked.searchParams);
  return createElement(
    OverlayProvider,
    null,
    createElement(
      ShellHeader,
      header,
      createElement(WorkspaceScopeHandoff, {
        snapshot: {
          factories,
          locationKey: workspaceScopeLocationKey(
            mocked.pathname,
            location?.detail ? undefined : query,
          ),
          picker: location?.detail ? "locked" : "header",
          scope: resolveWorkspaceScope(
            location,
            factories,
            query,
            location?.detail ? null : undefined,
          ),
          viewerId: header.viewerId,
          workspaceId: header.workspace.id,
        },
      }),
      "Page body",
    ),
  );
}

function mountShell(props: Partial<Omit<Parameters<typeof ShellHeader>[0], "children">> = {}) {
  return render(shellElement(props));
}

describe("ShellHeader", () => {
  let originalMatchMediaDescriptor: PropertyDescriptor | undefined;
  let originalResizeObserverDescriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
    originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );

    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        matches: false,
        media: query,
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
  });

  afterEach(async () => {
    cleanup();
    // Radix FocusScope schedules onCloseAutoFocus in a 0ms timeout on unmount.
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocked.pathname = "/w/acme-corp";
    mocked.prefetch.mockClear();
    mocked.replace.mockClear();
    mocked.searchParams = new URLSearchParams();
    window.localStorage.clear();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (originalMatchMediaDescriptor) {
      Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    if (originalResizeObserverDescriptor) {
      Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserverDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("replaces New session with Resume setup while onboarding is incomplete", () => {
    const html = renderShell({
      onboarding: { currentStep: "repository", status: "in_progress" },
    });

    expect(html).toContain('href="/w/acme-corp/onboarding"');
    expect(html).toContain("Resume setup");
    expect(html).not.toContain("New session");
    expect(html).not.toContain("data-dialog-state");
  });

  it("keeps New session available after onboarding is complete", () => {
    mountShell();
    expect(screen.getByRole("button", { name: "New session" })).toBeVisible();
    expect(screen.queryByText("Resume setup")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks the default-factory creation deep link for an unauthorized viewer", () => {
    mocked.searchParams = new URLSearchParams("create=1&factory=factory-1");
    mountShell({ factories: [] });
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["the workspace home", "/w/acme-corp", "", true],
    ["the explicit default factory scope", "/w/acme-corp", "factory=factory-1", true],
    ["a case-insensitive default factory id", "/w/acme-corp", "factory=FACTORY-1", true],
    ["a runs list page", "/w/acme-corp/runs", "", false],
    ["an unscoped session detail page", "/w/acme-corp/sessions/42", "", false],
    ["an unscoped run detail page", "/w/acme-corp/runs/run-1", "", false],
  ])(
    "places the New session launcher according to the view at %s",
    (_label, pathname, query, show) => {
      mocked.pathname = pathname;
      mocked.searchParams = new URLSearchParams(query);
      mountShell();
      expect(Boolean(screen.queryByRole("button", { name: "New session" }))).toBe(show);
      expect(screen.queryByRole("link", { name: /New session in/ })).toBeNull();
    },
  );

  it.each([
    ["another factory", "factory=other-factory", true],
    ["the all-factories aggregate", "factory=all", true],
    ["a repeated malformed scope", "factory=factory-1&factory=other-factory", false],
    ["an unknown factory id", "factory=missing-factory", false],
  ])("never rewrites New session to the default factory from %s", (_label, query, allowed) => {
    mocked.searchParams = new URLSearchParams(query);
    mountShell();
    expect(Boolean(screen.queryByRole("button", { name: "New session" }))).toBe(allowed);
    expect(screen.queryByRole("link", { name: /New session in/ })).toBeNull();
    expect(mocked.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["Inbox", "/w/acme-corp/inbox"],
    ["Activity", "/w/acme-corp/activity"],
    ["Governance", "/w/acme-corp/governance"],
    ["Context", "/w/acme-corp/context"],
    ["Memory", "/w/acme-corp/memory"],
  ])("does not route an implicit %s scope to a default-factory launch", (_label, pathname) => {
    mocked.pathname = pathname;
    mountShell();
    expect(screen.queryByRole("link", { name: /New session in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });

  it("blocks a create deep link in an unknown scope without offering a different factory", () => {
    mocked.searchParams = new URLSearchParams("create=1&factory=missing-factory");
    mountShell();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("link", { name: /New session in/ })).toBeNull();
  });

  it("updates the active factory section when an existing setup anchor is opened", async () => {
    mocked.pathname = "/w/acme-corp/settings/factory-definition";
    mocked.searchParams = new URLSearchParams("factory=factory-1");
    const initialUrl = window.location.href;
    try {
      mountShell({ canManageFactoryDefinition: true });
      const sections = within(screen.getByRole("navigation", { name: "Factory sections" }));
      const pipeline = sections.getByRole("link", { name: "Pipeline" });
      expect(pipeline).toHaveAttribute(
        "href",
        "/w/acme-corp/settings/factory-definition?factory=factory-1#definition-field-stages",
      );
      expect(pipeline).not.toHaveAttribute("aria-current");
      window.location.hash = "definition-field-stages";
      await waitFor(() => expect(pipeline).toHaveAttribute("aria-current", "page"));
    } finally {
      window.history.replaceState(null, "", initialUrl);
    }
  });

  it("restores the launch page, query, anchor and launcher focus on cancel", async () => {
    const origin = "/w/acme-corp/activity?factory=all&actor=example#recent";
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams({
      factory: "factory-1",
      create: "1",
      returnTo: origin,
    });
    const { rerender } = mountShell();

    const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith(origin, { scroll: true }));

    mocked.pathname = "/w/acme-corp/activity";
    mocked.searchParams = new URLSearchParams("factory=all&actor=example");
    rerender(shellElement());
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("uses Sessions rather than a different workspace as the direct URL fallback", async () => {
    mocked.pathname = "/w/acme-corp";
    mocked.searchParams = new URLSearchParams({
      create: "1",
      returnTo: "/w/another-workspace",
    });
    mountShell();

    const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(mocked.replace).toHaveBeenCalledWith("/w/acme-corp/sessions?factory=factory-1", {
        scroll: true,
      }),
    );
  });

  it("keeps an unsent draft mounted while the factory scope changes", async () => {
    await import("@/features/sessions/create-session-dialog");
    clientMocks.loadSessionRepositoryOptionsFromClient.mockResolvedValue({
      defaultGithubRepositoryId: null,
      pipelineId: null,
      repositoryOptions: [],
      stageOptions: [],
    });
    const view = mountShell();

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const prompt = await screen.findByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "Keep this draft" } });
    expect(prompt).toHaveValue("Keep this draft");

    mocked.searchParams = new URLSearchParams("factory=other-factory");
    view.rerender(shellElement());
    await waitFor(() => expect(screen.queryByLabelText("Prompt")).toBeNull());
    expect(screen.getByRole("button", { name: "New session" })).toBeVisible();

    mocked.searchParams = new URLSearchParams();
    view.rerender(shellElement());
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(await screen.findByLabelText("Prompt")).toHaveValue("Keep this draft");
  });

  it("renders the theme toggle with a hydration-safe accessible label", () => {
    const html = renderShell();

    expect(html).toContain('aria-label="Toggle color theme"');
    expect(html).not.toContain('title="Switch to dark mode"');
  });

  it("names the next theme action without a contradictory pressed state", () => {
    document.documentElement.dataset.theme = "light";
    mountShell();
    const button = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(button).not.toHaveAttribute("aria-pressed");
    fireEvent.click(button);
    expect(button).toHaveAccessibleName("Switch to light mode");
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(window.localStorage.getItem("wallie-theme")).toBe("dark");
    delete document.documentElement.dataset.theme;
  });

  it("keeps workspace identity in the top bar", () => {
    const html = renderShell();

    expect(html).not.toContain("Wallie");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("data-shell-rail");
    expect(html).toContain(">A<");
    expect(html).not.toContain('title="Acme Corp"');
  });

  it("renders an account menu exposing the signed-in email and sign-out", () => {
    const html = renderShell();

    expect(html).toContain('aria-label="Account: owner@example.com"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders the signed-in user's profile photo in the account trigger", () => {
    const html = renderShell({
      viewerAvatarUrl: "https://cdn.example.com/owner.png",
    });

    expect(html).toContain('src="https://cdn.example.com/owner.png"');
    expect(html).toContain('aria-label="Account: owner@example.com"');
  });

  it("exposes a named workspace drawer alongside desktop navigation", () => {
    const html = renderShell();

    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('aria-label="Workspace navigation: Sessions"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("data-shell-header");
    expect(html).toContain(">Sessions</");
    expect(html).not.toContain(">Pipeline</");
    expect(html).not.toContain(">Overview</");
    expect(html).toContain('href="/w/acme-corp"');
    expect(html).toContain('href="/w/acme-corp/runs"');
    expect(html).toContain('href="/w/acme-corp/settings"');
    expect(html).not.toContain("Factory definition");
  });

  it.each([
    ["/w/acme-corp", "Sessions"],
    ["/w/acme-corp/sessions", "Sessions"],
    ["/w/acme-corp/inbox", "Inbox"],
    ["/w/acme-corp/analytics", "Insights"],
    ["/w/acme-corp/settings/profile", "Settings"],
    ["/w/acme-corp/runs/run-id", "Activity"],
  ])("names the drawer trigger after the current destination at %s", (pathname, label) => {
    mocked.pathname = pathname;

    const html = renderShell();

    expect(html).toContain(`aria-label="Workspace navigation: ${label}"`);
    expect(html).toContain('aria-current="page"');
  });

  it("keeps the main content in the document scroll", () => {
    const html = renderShell();

    expect(html).toContain('id="main-content"');
    expect(html).toContain("Page body");
    expect(html.match(/<main[^>]*>/u)?.[0]).not.toContain("overflow-y-auto");
  });

  it.each([true, false])(
    "addresses the selected factory on Graph workflows without falling back (%s)",
    (manageable) => {
      const selectedFactory = manageable ? creationFactory.id : "other-factory";
      mocked.pathname = "/w/acme-corp/agents";
      mocked.searchParams = new URLSearchParams({ factory: selectedFactory });
      mountShell();
      const sections = within(screen.getByRole("navigation", { name: "Factory sections" }));
      expect(sections.getByRole("link", { name: "Graph workflows" })).toHaveAttribute(
        "href",
        `/w/acme-corp/workflows?factory=${selectedFactory}`,
      );
    },
  );

  it("shows the definition route within Factory only when authorized", () => {
    mocked.pathname = "/w/acme-corp/agents";
    mocked.searchParams = new URLSearchParams("factory=factory-1");
    const view = mountShell({ canManageFactoryDefinition: true });
    const nav = within(screen.getByRole("navigation", { name: "Workspace navigation" }));
    const sections = within(screen.getByRole("navigation", { name: "Factory sections" }));
    expect(nav.getByRole("link", { name: "Factory" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
    expect(sections.getByRole("link", { name: "Definition" })).toHaveAttribute(
      "href",
      "/w/acme-corp/settings/factory-definition?factory=factory-1",
    );
    view.rerender(shellElement({ canManageFactoryDefinition: false }));
    expect(sections.queryByRole("link", { name: "Definition" })).toBeNull();
  });

  it("keeps scope on aggregate links and preserves workspace Settings URLs", () => {
    mocked.searchParams = new URLSearchParams("factory=all");
    mountShell();
    const nav = within(screen.getByRole("navigation", { name: "Workspace navigation" }));
    for (const [name, href] of [
      ["Sessions", "/w/acme-corp?factory=all"],
      ["Activity", "/w/acme-corp/runs?factory=all"],
      ["Inbox", "/w/acme-corp/inbox?factory=all"],
      ["Settings", "/w/acme-corp/settings"],
      ["Insights", "/w/acme-corp/analytics?factory=all"],
    ])
      expect(nav.getByRole("link", { name })).toHaveAttribute("href", href);
  });

  it.each([
    ["Activity", ""],
    ["Inbox", ""],
    ["Inbox", "factory=all"],
  ])("keeps the effective aggregate scope from %s in rail and drawer", async (label, search) => {
    mocked.pathname = `/w/acme-corp/${label.toLowerCase()}`;
    mocked.searchParams = new URLSearchParams(search);
    mountShell();

    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/w/acme-corp/sessions?factory=all",
    );
    fireEvent.click(screen.getByRole("button", { name: `Workspace navigation: ${label}` }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace pages" });
    expect(within(drawer).getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/w/acme-corp/sessions?factory=all",
    );
    expect(within(drawer).queryByRole("link", { name: "Overview" })).toBeNull();
    expect(within(drawer).getByRole("link", { name: "Insights" })).toHaveAttribute(
      "href",
      "/w/acme-corp/analytics?factory=all",
    );
  });

  it("keeps the desktop sidebar always expanded without a collapse control", () => {
    window.localStorage.setItem("wallie-sidebar:v1", "collapsed");
    mountShell();

    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    expect(document.querySelector("[data-shell-rail]")).not.toHaveAttribute("data-collapsed");
    expect(screen.getByRole("link", { name: "Activity" })).toBeVisible();
  });

  it("prefetches desktop navigation links on mouse/pen hover or focus and skips touch pointers", () => {
    mocked.pathname = "/w/acme-corp/analytics";
    mountShell();

    const sessionsLink = screen.getByRole("link", { name: "Sessions" });
    expect(sessionsLink.getAttribute("href")).toBe("/w/acme-corp/sessions?factory=all");

    fireEvent.pointerEnter(sessionsLink, { pointerType: "touch" });
    expect(mocked.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(sessionsLink, { pointerType: "mouse" });
    expect(mocked.prefetch).toHaveBeenCalledTimes(1);
    expect(mocked.prefetch).toHaveBeenCalledWith("/w/acme-corp/sessions?factory=all", {
      kind: PrefetchKind.FULL,
    });

    fireEvent.focus(sessionsLink);
    expect(mocked.prefetch).toHaveBeenCalledTimes(1);

    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink.getAttribute("href")).toBe("/w/acme-corp/settings");

    fireEvent.focus(settingsLink);
    expect(mocked.prefetch).toHaveBeenCalledTimes(2);
    expect(mocked.prefetch).toHaveBeenNthCalledWith(2, "/w/acme-corp/settings", {
      kind: PrefetchKind.FULL,
    });

    fireEvent.pointerEnter(settingsLink, { pointerType: "pen" });
    expect(mocked.prefetch).toHaveBeenCalledTimes(2);
  });

  it("prefetches drawer links on mouse hover or focus and skips touch pointers", async () => {
    mocked.pathname = "/w/acme-corp/analytics";
    mountShell();

    const drawerTrigger = screen.getByRole("button", { name: "Workspace navigation: Insights" });
    fireEvent.click(drawerTrigger);

    const drawer = await screen.findByRole("dialog", { name: "Workspace pages" });
    const compactSessionsLink = within(drawer).getByRole("link", { name: "Sessions" });
    expect(compactSessionsLink.getAttribute("href")).toBe("/w/acme-corp/sessions?factory=all");

    fireEvent.pointerEnter(compactSessionsLink, { pointerType: "touch" });
    expect(mocked.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(compactSessionsLink, { pointerType: "mouse" });
    expect(mocked.prefetch).toHaveBeenCalledTimes(1);
    expect(mocked.prefetch).toHaveBeenCalledWith("/w/acme-corp/sessions?factory=all", {
      kind: PrefetchKind.FULL,
    });

    fireEvent.focus(compactSessionsLink);
    expect(mocked.prefetch).toHaveBeenCalledTimes(1);
  });

  it("switches by name without carrying the old scope, while the current Pipeline link keeps it", async () => {
    mocked.pathname = "/w/acme-corp/activity";
    mountShell({
      workspaceOptions: [
        { name: "Acme Corp", slug: "acme-corp" },
        { name: "Acme Corp", slug: "another-acme" },
        { name: "Tailspin Toys", slug: "tailspin" },
      ],
    });
    const trigger = screen.getByRole("button", { name: "Switch workspace: Acme Corp" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Switch workspace" });
    const current = within(menu).getByRole("menuitem", {
      name: "Acme Corp acme-corp · Current workspace",
    });
    expect(current).toHaveAttribute("href", "/w/acme-corp?factory=all");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(within(menu).getByRole("menuitem", { name: "Acme Corp another-acme" })).toHaveAttribute(
      "href",
      "/w/another-acme",
    );
    expect(within(menu).getByRole("menuitem", { name: "Tailspin Toys" })).toHaveAttribute(
      "href",
      "/w/tailspin",
    );
    fireEvent.keyDown(current, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows a focused Retry after a failed load and retries without closing", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const onClose = vi.fn();
    render(
      createElement(
        OverlayProvider,
        null,
        createElement(CreateSessionDialogRequest, { load, onClose }),
      ),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Couldn’t load the session form");
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading session form");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("shell page title helpers", () => {
  it("marks the board root, list, and detail under one Sessions item", () => {
    for (const suffix of ["", "/sessions", "/sessions/42"]) {
      expect(matchWorkspaceLocation(`/w/acme-corp${suffix}`, "acme-corp")?.destination).toBe(
        "sessions",
      );
    }
    for (const suffix of ["/analytics", "/runs/run-id"]) {
      expect(matchWorkspaceLocation(`/w/acme-corp${suffix}`, "acme-corp")?.destination).not.toBe(
        "sessions",
      );
    }
  });
});

describe("prefetchShellNavHrefOnIntent", () => {
  it("prefetches a different workspace route with PrefetchKind.FULL on first intent", () => {
    const prefetch = vi.fn();
    const prefetchedKeys = new Set<string>();

    const triggered = prefetchShellNavHrefOnIntent(
      { prefetch },
      prefetchedKeys,
      "/w/acme-corp",
      "/w/acme-corp/sessions",
    );

    expect(triggered).toBe(true);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/w/acme-corp/sessions", {
      kind: PrefetchKind.FULL,
    });
    expect(prefetchedKeys.has("/w/acme-corp->/w/acme-corp/sessions")).toBe(true);
  });

  it("deduplicates repeated hover or focus intent for the same pathname and targetHref", () => {
    const prefetch = vi.fn();
    const prefetchedKeys = new Set<string>();

    expect(
      prefetchShellNavHrefOnIntent(
        { prefetch },
        prefetchedKeys,
        "/w/acme-corp",
        "/w/acme-corp/settings",
      ),
    ).toBe(true);
    expect(
      prefetchShellNavHrefOnIntent(
        { prefetch },
        prefetchedKeys,
        "/w/acme-corp",
        "/w/acme-corp/settings",
      ),
    ).toBe(false);

    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("skips prefetching when targetHref matches currentPathname", () => {
    const prefetch = vi.fn();
    const prefetchedKeys = new Set<string>();

    const triggered = prefetchShellNavHrefOnIntent(
      { prefetch },
      prefetchedKeys,
      "/w/acme-corp",
      "/w/acme-corp",
    );

    expect(triggered).toBe(false);
    expect(prefetch).not.toHaveBeenCalled();
    expect(prefetchedKeys.size).toBe(0);
  });

  it("re-prefetches the target route after currentPathname changes", () => {
    const prefetch = vi.fn();
    const prefetchedKeys = new Set<string>();

    expect(
      prefetchShellNavHrefOnIntent(
        { prefetch },
        prefetchedKeys,
        "/w/acme-corp",
        "/w/acme-corp/sessions",
      ),
    ).toBe(true);
    expect(
      prefetchShellNavHrefOnIntent(
        { prefetch },
        prefetchedKeys,
        "/w/acme-corp/settings",
        "/w/acme-corp/sessions",
      ),
    ).toBe(true);

    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenNthCalledWith(1, "/w/acme-corp/sessions", {
      kind: PrefetchKind.FULL,
    });
    expect(prefetch).toHaveBeenNthCalledWith(2, "/w/acme-corp/sessions", {
      kind: PrefetchKind.FULL,
    });
  });
});

describe("create-session dialog loading", () => {
  it("waits for the client overlay root before rendering portal content", () => {
    const html = renderToStaticMarkup(createElement(CreateSessionDialogLoading));

    expect(html).toBe("");
  });

  it("deduplicates preloads for one shell mount", () => {
    const startedKey = new Set<string>();
    const preloadSessionRepositories = vi.fn(async () => ({
      defaultGithubRepositoryId: null,
      pipelineId: null,
      repositoryOptions: [],
      stageOptions: [],
    }));
    const load = vi.fn(async () => ({ preloadSessionRepositories }));
    const input = { userId: "user-1", workspaceId: "workspace-1", factoryId: "factory-1" };

    preloadCreateSessionDialogOnce(startedKey, input, load);
    preloadCreateSessionDialogOnce(startedKey, input, load);

    expect(load).toHaveBeenCalledTimes(1);
    return vi.waitFor(() => expect(preloadSessionRepositories).toHaveBeenCalledWith(input));
  });

  it("resets the guard so a failed preload can retry", async () => {
    const startedKey = new Set<string>();
    const preloadSessionRepositories = vi.fn(async () => {
      throw new Error("repositories failed");
    });
    const load = vi.fn(async () => ({ preloadSessionRepositories }));
    const input = { userId: "user-1", workspaceId: "workspace-1", factoryId: "factory-1" };

    preloadCreateSessionDialogOnce(startedKey, input, load);
    await vi.waitFor(() => expect(startedKey.size).toBe(0));

    preloadCreateSessionDialogOnce(startedKey, input, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys repository preloads by account, workspace and factory and only loads the chunk from All", async () => {
    const startedKey = new Set<string>();
    const preloadSessionRepositories = vi.fn(async () => ({
      defaultGithubRepositoryId: null,
      pipelineId: null,
      repositoryOptions: [],
      stageOptions: [],
    }));
    const load = vi.fn(async () => ({ preloadSessionRepositories }));

    const input = { userId: "user-1", workspaceId: "workspace-1", factoryId: "factory-1" };
    preloadCreateSessionDialogOnce(startedKey, input, load);
    preloadCreateSessionDialogOnce(startedKey, { ...input, workspaceId: "workspace-2" }, load);
    preloadCreateSessionDialogOnce(startedKey, { ...input, userId: "user-2" }, load);
    preloadCreateSessionDialogOnce(startedKey, { ...input, factoryId: "factory-2" }, load);
    preloadCreateSessionDialogOnce(startedKey, { ...input, factoryId: undefined }, load);
    preloadCreateSessionDialogOnce(startedKey, input, load);

    expect(load).toHaveBeenCalledTimes(5);
    await vi.waitFor(() => expect(preloadSessionRepositories).toHaveBeenCalledTimes(4));
    expect(preloadSessionRepositories).not.toHaveBeenCalledWith({
      ...input,
      factoryId: undefined,
    });
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
