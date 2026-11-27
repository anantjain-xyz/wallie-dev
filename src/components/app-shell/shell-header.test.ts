// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { createElement, type ReactNode } from "react";
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
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useRouter: () => ({ prefetch: mocked.prefetch, push: mocked.push, replace: mocked.replace }),
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
const releaseWorkflow = {
  workflowId: "00000000-0000-4000-8000-000000000011",
  activationId: "00000000-0000-4000-8000-000000000012",
  label: "Release workflow",
};
const workflowOrigin = "/w/acme-corp/workflows?factory=factory-1&q=release#workflow-release";

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

function shellElement(props: Partial<HeaderProps> = {}, children: ReactNode = "Page body") {
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
      children,
    ),
  );
}

function mountShell(props: Partial<Omit<Parameters<typeof ShellHeader>[0], "children">> = {}) {
  return render(shellElement(props));
}

function mockScopedSessionOptions(definitionDigest?: string) {
  clientMocks.loadSessionRepositoryOptionsFromClient.mockImplementation(({ factoryId }) =>
    Promise.resolve({
      defaultGithubRepositoryId: "repo",
      ...(definitionDigest ? { factoryDefinitionDigest: definitionDigest } : {}),
      factoryId,
      pipelineId: "pipeline",
      repositoryOptions: [{ id: "repo", fullName: "examples/product" }],
      stageOptions: [{ id: "plan", name: "Plan", position: 0, description: "" }],
    }),
  );
}

function mockWorkflowSessionOptions(options = [releaseWorkflow]) {
  const definitionDigest = "d".repeat(64);
  mockScopedSessionOptions(definitionDigest);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ definitionDigest, options }),
  );
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
    mocked.push.mockClear();
    mocked.replace.mockClear();
    mocked.searchParams = new URLSearchParams();
    window.localStorage.clear();
    vi.restoreAllMocks();
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

  it("blocks creation on the eligible Board while workspace onboarding is incomplete", () => {
    mocked.searchParams = new URLSearchParams({ factory: creationFactory.id, create: "1" });
    mountShell({ onboarding: { currentStep: "repository", status: "in_progress" } });

    expect(screen.getByRole("link", { name: /Resume setup/ })).toHaveAttribute(
      "href",
      "/w/acme-corp/onboarding",
    );
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
    expect(mocked.replace).toHaveBeenCalledWith("/w/acme-corp/onboarding");
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

  it.each([
    ["success before the switch commits", "success"],
    ["a rejected request after the switch commits", "rejected"],
    ["an unconfirmed request started from All factories", "unconfirmed"],
    ["a rejected workflow launch after its URL is cleaned", "workflow"],
    ["loss of eligibility without a picker interaction", "ineligible"],
  ] as const)("releases the creation preview for %s", async (_label, outcome) => {
    const fromAll = outcome === "unconfirmed";
    const launch = outcome === "workflow";
    const target = fromAll ? defaultOptions[1] : creationFactory;
    const archivedFactory = {
      id: "archive",
      name: "Archive",
      isDefault: false,
      status: "archived",
    } satisfies FactorySelectionOption;
    const header = {
      factories: [...defaultOptions, archivedFactory],
      viewerId: `creation-${outcome}`,
    };
    const archiveHref = "/w/acme-corp/sessions?factory=archive";
    const canonicalUrl = "/w/acme-corp/sessions/42";
    const draftPrompt = "Document the new approval flow";
    const pending = Promise.withResolvers<{ canonicalUrl: string; number: number }>();
    clientMocks.createSessionFromClient.mockReset().mockReturnValueOnce(pending.promise);
    clientMocks.loadSessionCreationFactoriesFromClient.mockResolvedValue(defaultOptions);
    if (launch) mockWorkflowSessionOptions();
    else mockScopedSessionOptions();

    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams({
      factory: fromAll ? "all" : target.id,
      ...(launch
        ? {
            create: "1",
            returnTo: workflowOrigin,
            workflowActivation: releaseWorkflow.activationId,
          }
        : {}),
    });
    const view = render(shellElement(header, createElement("h1", null, "Sessions")));
    if (!launch) fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const prompt = await screen.findByLabelText("Prompt");
    const dialog = screen.getByRole("dialog", { name: "Start a new session" });
    if (fromAll) {
      fireEvent.click(await within(dialog).findByRole("combobox", { name: "Factory" }));
      fireEvent.click(screen.getByRole("option", { name: target.name }));
    }
    fireEvent.change(prompt, {
      target: { value: draftPrompt },
    });
    const submit = within(dialog).getByRole("button", { name: "Start session" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(await screen.findByRole("region", { name: "Creating session" })).toBeVisible();
    const [original] = clientMocks.createSessionFromClient.mock.calls[0];
    expect(original.factoryId).toBe(target.id);
    if (launch) {
      const cleanUrl = `${mocked.pathname}?factory=${target.id}`;
      expect(mocked.replace).toHaveBeenCalledExactlyOnceWith(cleanUrl, { scroll: false });
      expect(original.workflowSelection).toEqual({
        workflowId: releaseWorkflow.workflowId,
        activationId: releaseWorkflow.activationId,
      });
      mocked.searchParams = new URLSearchParams({ factory: target.id });
      view.rerender(shellElement(header, createElement("h1", null, "Sessions")));
      expect(screen.getByRole("region", { name: "Creating session" })).toBeVisible();
    }

    if (outcome !== "ineligible") {
      fireEvent.click(screen.getByRole("combobox", { name: "Factory" }));
      fireEvent.click(screen.getByRole("option", { name: "Archive (archived)" }));
      expect(mocked.push).toHaveBeenCalledExactlyOnceWith(archiveHref, { scroll: false });
      expect(screen.getByRole("heading", { name: "Sessions" })).toBeVisible();
    }

    const settle = () =>
      act(async () => {
        if (outcome === "unconfirmed") pending.reject(new TypeError("Failed to fetch"));
        else if (outcome === "rejected" || launch)
          pending.reject(
            Object.assign(new Error("Repository unavailable"), { creationRejected: true }),
          );
        else pending.resolve({ canonicalUrl, number: 42 });
      });
    if (outcome === "success") await settle();
    if (outcome === "ineligible") {
      view.rerender(
        shellElement(
          {
            ...header,
            factories: header.factories.map((factory) =>
              factory.id === target.id ? { ...factory, status: "archived" } : factory,
            ),
          },
          createElement("h1", null, "Archived sessions"),
        ),
      );
    } else {
      mocked.searchParams = new URLSearchParams("factory=archive");
      view.rerender(shellElement(header, createElement("h1", null, "Archived sessions")));
    }
    expect(screen.getByRole("heading", { name: "Archived sessions" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Creating session" })).toBeNull();
    if (outcome !== "success") await settle();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
    expect(mocked.push).toHaveBeenCalledTimes(outcome === "ineligible" ? 0 : 1);

    if (outcome === "success" || outcome === "ineligible") {
      fireEvent.click(await screen.findByRole("button", { name: "Open session" }));
      expect(mocked.push).toHaveBeenLastCalledWith(canonicalUrl);
      return;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Open draft" }));
    const recoveryQuery = new URLSearchParams({
      factory: target.id,
      create: "1",
      ...(launch
        ? { returnTo: workflowOrigin, workflowActivation: releaseWorkflow.activationId }
        : {}),
    });
    expect(mocked.push.mock.lastCall?.[0]).toBe(`${mocked.pathname}?${recoveryQuery}`);
    expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
    mocked.searchParams = recoveryQuery;
    if (outcome === "rejected") {
      view.rerender(
        shellElement({
          ...header,
          factories: header.factories.filter(({ id }) => id !== target.id),
        }),
      );
      expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
    }
    view.rerender(shellElement(header));
    const recovered = await screen.findByRole("dialog", { name: "Start a new session" });
    expect(within(recovered).getByLabelText("Prompt")).toHaveValue(draftPrompt);
    if (launch) {
      expect(await within(recovered).findByText(releaseWorkflow.label)).toBeVisible();
      fireEvent.keyDown(recovered, { key: "Escape" });
      expect(mocked.replace).toHaveBeenLastCalledWith(workflowOrigin, { scroll: true });
      return;
    }
    const unconfirmed = outcome === "unconfirmed";
    const retry = within(recovered).getByRole("button", {
      name: unconfirmed ? "Retry creation" : "Start session",
    });
    clientMocks.createSessionFromClient.mockResolvedValueOnce({ canonicalUrl, number: 42 });
    await waitFor(() => expect(retry).toBeEnabled());
    await act(async () => fireEvent.click(retry));
    expect(clientMocks.createSessionFromClient).toHaveBeenCalledTimes(2);
    const [replayed] = clientMocks.createSessionFromClient.mock.calls[1];
    if (unconfirmed) expect(replayed).toEqual(original);
    else {
      expect(replayed).toEqual({ ...original, requestId: expect.any(String) });
      expect(replayed.requestId).not.toBe(original.requestId);
    }
  });

  it.each(["canonical detail", "an archived switch"] as const)(
    "honors the next workflow launch's exact return after confirming creation and opening %s",
    async (destination) => {
      const sessions = "/w/acme-corp/sessions";
      const canonicalUrl = `${sessions}/42`;
      const archivedFactory = {
        id: "archive",
        name: "Archive",
        isDefault: false,
        status: "archived",
      } satisfies FactorySelectionOption;
      const header = {
        factories: [...defaultOptions, archivedFactory],
        viewerId: `confirmed-${destination}`,
      };
      mocked.pathname = sessions;
      mocked.searchParams = new URLSearchParams({ factory: creationFactory.id });
      clientMocks.createSessionFromClient
        .mockReset()
        .mockResolvedValueOnce({ canonicalUrl, number: 42 });
      mockScopedSessionOptions();
      const view = mountShell(header);
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      fireEvent.change(await screen.findByLabelText("Prompt"), {
        target: { value: "Document the completed request" },
      });
      const submit = screen.getByRole("button", { name: "Start session" });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
      await waitFor(() => expect(mocked.push).toHaveBeenCalledExactlyOnceWith(canonicalUrl));
      expect(screen.getByRole("region", { name: "Creating session" })).toBeVisible();

      if (destination === "canonical detail") {
        mocked.pathname = canonicalUrl;
        mocked.searchParams = new URLSearchParams();
      } else {
        fireEvent.click(screen.getByRole("combobox", { name: "Factory" }));
        fireEvent.click(screen.getByRole("option", { name: "Archive (archived)" }));
        expect(mocked.push).toHaveBeenLastCalledWith(`${sessions}?factory=archive`, {
          scroll: false,
        });
        mocked.searchParams = new URLSearchParams({ factory: archivedFactory.id });
      }
      view.rerender(shellElement(header));
      expect(screen.queryByRole("region", { name: "Creating session" })).toBeNull();

      mocked.pathname = sessions;
      mocked.searchParams = new URLSearchParams({
        factory: creationFactory.id,
        create: "1",
        returnTo: workflowOrigin,
        workflowActivation: releaseWorkflow.activationId,
      });
      view.rerender(shellElement(header));
      const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(mocked.replace).toHaveBeenLastCalledWith(workflowOrigin, { scroll: true });
    },
  );

  it.each(["resume the preview", "resume after Back", "start after completion"] as const)(
    "keeps a launch for its pending draft only when choosing to %s",
    async (action) => {
      const header = { viewerId: `launch-${action}` };
      const canonicalUrl = "/w/acme-corp/sessions/42";
      const pending = Promise.withResolvers<{ canonicalUrl: string; number: number }>();
      const rejected = Object.assign(new Error("Repository unavailable"), {
        creationRejected: true,
      });
      const draft = "Prepare the release checklist";
      clientMocks.createSessionFromClient
        .mockReset()
        .mockReturnValueOnce(pending.promise)
        .mockRejectedValueOnce(rejected);
      mockWorkflowSessionOptions();
      mocked.pathname = "/w/acme-corp/sessions";
      mocked.searchParams = new URLSearchParams({
        factory: creationFactory.id,
        create: "1",
        returnTo: workflowOrigin,
        workflowActivation: releaseWorkflow.activationId,
      });
      const view = mountShell(header);
      fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: draft } });
      const submit = screen.getByRole("button", { name: "Start session" });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
      const [original] = clientMocks.createSessionFromClient.mock.calls[0];
      expect(original.workflowSelection).toEqual({
        workflowId: releaseWorkflow.workflowId,
        activationId: releaseWorkflow.activationId,
      });
      mocked.searchParams = new URLSearchParams({ factory: creationFactory.id });
      view.rerender(shellElement(header));
      const back = screen.getByRole("button", { name: /Back to workspace/ });
      if (action !== "resume the preview") fireEvent.click(back);

      if (action === "start after completion") {
        await act(async () => pending.resolve({ canonicalUrl, number: 42 }));
        expect(mocked.push).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "New session" }));
        expect(await screen.findByLabelText("Prompt")).toHaveValue("");
        expect(await screen.findByRole("combobox", { name: "Workflow" })).toHaveTextContent(
          "Default pipeline",
        );
        return;
      }

      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      expect(screen.getByRole("region", { name: "Creating session" })).toBeVisible();
      await act(async () => pending.reject(rejected));
      expect(await screen.findByText(releaseWorkflow.label)).toBeVisible();
      expect(screen.getByLabelText("Prompt")).toHaveValue(draft);
      const retry = screen.getByRole("button", { name: "Start session" });
      await waitFor(() => expect(retry).toBeEnabled());
      await act(async () => fireEvent.click(retry));
      const [resubmitted] = clientMocks.createSessionFromClient.mock.calls[1];
      expect(resubmitted.workflowSelection).toEqual(original.workflowSelection);
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Start a new session" }), {
        key: "Escape",
      });
      expect(mocked.replace).toHaveBeenLastCalledWith(workflowOrigin, { scroll: true });
    },
  );

  it.each(["viewer", "workspace"] as const)(
    "does not carry a saved workflow launch across a change of %s at the same URL",
    async (identity) => {
      const owner = { viewerId: `workflow-owner-${identity}` };
      const next =
        identity === "viewer"
          ? { viewerId: "another-viewer" }
          : { ...owner, workspace: { ...workspace, id: "another-workspace" } };
      const canonicalUrl = "/w/acme-corp/sessions/42";
      const pending = Promise.withResolvers<{ canonicalUrl: string; number: number }>();
      clientMocks.createSessionFromClient.mockReset().mockReturnValueOnce(pending.promise);
      mockWorkflowSessionOptions();
      mocked.pathname = "/w/acme-corp/sessions";
      mocked.searchParams = new URLSearchParams({
        factory: creationFactory.id,
        create: "1",
        returnTo: workflowOrigin,
        workflowActivation: releaseWorkflow.activationId,
      });
      const view = mountShell(owner);
      fireEvent.change(await screen.findByLabelText("Prompt"), {
        target: { value: "Prepare the original release" },
      });
      const submit = screen.getByRole("button", { name: "Start session" });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);

      mocked.searchParams = new URLSearchParams({ factory: creationFactory.id });
      view.rerender(shellElement(owner));
      fireEvent.click(screen.getByRole("button", { name: /Back to workspace/ }));
      mocked.replace.mockClear();
      view.rerender(shellElement(next));
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
      expect(within(dialog).getByLabelText("Prompt")).toHaveValue("");
      expect(await within(dialog).findByRole("combobox", { name: "Workflow" })).toHaveTextContent(
        "Default pipeline",
      );
      expect(within(dialog).queryByText(releaseWorkflow.label)).toBeNull();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(mocked.replace).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      expect(screen.getByRole("dialog", { name: "Start a new session" })).toBeVisible();
      view.rerender(shellElement(owner));
      expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
      await act(async () => pending.resolve({ canonicalUrl, number: 42 }));
      expect(mocked.push).not.toHaveBeenCalled();
      expect(screen.queryByText("Session #42 created.")).toBeNull();
    },
  );

  it.each([
    { outcome: "success", close: "Escape" },
    { outcome: "rejected", close: "Escape" },
    { outcome: "unconfirmed", close: "Escape" },
    { outcome: "success", close: "Discard draft" },
    { outcome: "rejected", close: "Discard draft" },
  ] as const)(
    "keeps the newer workflow launch open after $outcome, until $close",
    async ({ outcome, close }) => {
      const header = { viewerId: `overlapping-launches-${outcome}-${close}` };
      const sessions = "/w/acme-corp/sessions";
      const canonicalUrl = "/w/acme-corp/sessions/42";
      const pending = Promise.withResolvers<{ canonicalUrl: string; number: number }>();
      const nextWorkflow = {
        ...releaseWorkflow,
        activationId: "00000000-0000-4000-8000-000000000013",
        label: "Next release workflow",
      };
      const nextOrigin = "/w/acme-corp/workflows?factory=factory-1&q=next#workflow-next";
      const originalQuery = new URLSearchParams({
        factory: creationFactory.id,
        create: "1",
        returnTo: workflowOrigin,
        workflowActivation: releaseWorkflow.activationId,
      });
      clientMocks.createSessionFromClient.mockReset().mockReturnValueOnce(pending.promise);
      mockWorkflowSessionOptions([releaseWorkflow, nextWorkflow]);
      mocked.pathname = sessions;
      mocked.searchParams = originalQuery;
      const view = mountShell(header);
      fireEvent.change(await screen.findByLabelText("Prompt"), {
        target: { value: "Publish the earlier release" },
      });
      const submit = screen.getByRole("button", { name: "Start session" });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
      expect(screen.getByRole("region", { name: "Creating session" })).toBeVisible();
      const [original] = clientMocks.createSessionFromClient.mock.calls[0];
      expect(mocked.replace).toHaveBeenCalledExactlyOnceWith(
        `${sessions}?factory=${creationFactory.id}`,
        { scroll: false },
      );

      mocked.searchParams = new URLSearchParams({
        factory: creationFactory.id,
        create: "1",
        returnTo: nextOrigin,
        workflowActivation: nextWorkflow.activationId,
      });
      view.rerender(shellElement(header));
      const nextDialog = screen.getByRole("dialog", { name: "Start a new session" });
      expect(screen.queryByRole("region", { name: "Creating session" })).toBeNull();
      expect(within(nextDialog).getByRole("button", { name: "Close" })).toBeEnabled();
      expect(mocked.replace).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (outcome === "success") pending.resolve({ canonicalUrl, number: 42 });
        else if (outcome === "rejected")
          pending.reject(
            Object.assign(new Error("Repository unavailable"), { creationRejected: true }),
          );
        else pending.reject(new TypeError("Failed to fetch"));
      });
      expect(nextDialog).toBeVisible();
      if (outcome !== "unconfirmed") {
        expect(await within(nextDialog).findByText(nextWorkflow.label)).toBeVisible();
      } else {
        expect(within(nextDialog).getByRole("button", { name: "Retry creation" })).toBeDisabled();
      }
      expect(mocked.push).not.toHaveBeenCalled();
      expect(mocked.replace).toHaveBeenCalledTimes(1);
      const resultTitle =
        outcome === "success" ? "Session #42 created." : "Session creation needs attention.";
      expect(screen.queryByText(resultTitle)).toBeNull();
      if (close === "Escape") fireEvent.keyDown(nextDialog, { key: "Escape" });
      else fireEvent.click(within(nextDialog).getByRole("button", { name: close }));
      expect(mocked.replace).toHaveBeenLastCalledWith(nextOrigin, { scroll: true });
      expect(screen.queryByRole("dialog", { name: "Start a new session" })).toBeNull();
      if (close === "Discard draft" && outcome === "rejected") {
        expect(screen.queryByText(resultTitle)).toBeNull();
        return;
      }
      expect(await screen.findByText(resultTitle)).toBeVisible();
      if (outcome === "success") {
        fireEvent.click(await screen.findByRole("button", { name: "Open session" }));
        expect(mocked.push).toHaveBeenCalledExactlyOnceWith(canonicalUrl);
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "Open draft" }));
        expect(mocked.push).toHaveBeenCalledExactlyOnceWith(`${sessions}?${originalQuery}`);
        mocked.searchParams = originalQuery;
        view.rerender(shellElement(header));
        const recovered = screen.getByRole("dialog", { name: "Start a new session" });
        expect(await within(recovered).findByText(releaseWorkflow.label)).toBeVisible();
        expect(within(recovered).getByLabelText("Prompt")).toHaveValue(original.promptMd);
        if (outcome === "unconfirmed") {
          const retry = within(recovered).getByRole("button", { name: "Retry creation" });
          await waitFor(() => expect(retry).toBeEnabled());
          clientMocks.createSessionFromClient.mockResolvedValueOnce({ canonicalUrl, number: 42 });
          await act(async () => fireEvent.click(retry));
          expect(clientMocks.createSessionFromClient).toHaveBeenNthCalledWith(2, original);
        }
      }
    },
  );

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
