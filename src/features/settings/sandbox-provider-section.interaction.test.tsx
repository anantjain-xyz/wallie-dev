// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SandboxProviderSection } from "@/features/settings/sandbox-provider-section";
import type {
  SandboxConnectionPreviews,
  SandboxSettingsResponse,
} from "@/lib/sandbox-connections/contracts";
import type { SandboxProvider } from "@/lib/sandbox";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-17T12:00:00.000Z";
const axeOptions = { rules: { "color-contrast": { enabled: false } } };

const vercelConnection = {
  connectionRevision: "revision-vercel",
  lastValidatedAt: timestamp,
  lastValidationError: null,
  projectId: "prj_123",
  projectName: "wallie-sandboxes",
  status: "connected" as const,
  teamId: "team_123",
  tokenPreview: "vca_…1234",
  updatedAt: timestamp,
  workspaceId,
};

const e2bConnection = {
  apiKeyPreview: "e2b_…1234",
  connectionRevision: "revision-e2b",
  lastValidatedAt: timestamp,
  lastValidationError: null,
  status: "connected" as const,
  updatedAt: timestamp,
  workspaceId,
};

const daytonaConnection = {
  apiKeyPreview: "daytona_…1234",
  apiUrl: "https://app.daytona.io/api",
  connectionRevision: "revision-daytona",
  lastValidatedAt: timestamp,
  lastValidationError: null,
  status: "connected" as const,
  target: "us",
  updatedAt: timestamp,
  workspaceId,
};

function sandboxSettings(
  connections: Partial<SandboxConnectionPreviews> = {},
): SandboxSettingsResponse {
  return {
    activeProvider: "vercel",
    connections: { daytona: null, e2b: null, vercel: null, ...connections },
    enabledProviders: ["vercel", "e2b", "daytona"],
    revision: 1,
    updatedAt: null,
  };
}

const updatedLabel = "Updated Jul 17, 2026";

function renderSection({
  canManage = true,
  settings = sandboxSettings(),
  stateful = false,
  variant,
}: {
  canManage?: boolean;
  settings?: SandboxSettingsResponse;
  stateful?: boolean;
  variant?: "onboarding" | "settings";
} = {}) {
  const onSettingsChange = vi.fn();
  const onDraftStateChange = vi.fn();
  const setFlashMessage = vi.fn();

  function Harness() {
    const [currentSettings, setCurrentSettings] = useState(settings);
    return (
      <SandboxProviderSection
        canManage={canManage}
        onDraftStateChange={onDraftStateChange}
        onSettingsChange={(next) => {
          onSettingsChange(next);
          if (stateful) setCurrentSettings(next);
        }}
        setFlashMessage={setFlashMessage}
        settings={currentSettings}
        variant={variant}
        vercelConnection={currentSettings.connections.vercel}
        workspaceId={workspaceId}
      />
    );
  }

  render(
    <OverlayProvider>
      <Harness />
    </OverlayProvider>,
  );

  return { onDraftStateChange, onSettingsChange, setFlashMessage };
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("SandboxProviderSection provider selection", () => {
  it("reveals only the selected provider form during onboarding", async () => {
    const user = userEvent.setup();
    renderSection({ settings: sandboxSettings(), variant: "onboarding" });

    expect(
      screen.getByText("Select a provider to continue with its connection details."),
    ).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /Vercel Sandbox/ }));
    expect(screen.getByRole("heading", { name: "Connect Vercel Sandbox" })).toBeVisible();
    expect(screen.getByLabelText("Token")).toBeVisible();
    expect(screen.getByRole("button", { name: "Find teams" })).toBeVisible();
    expect(screen.queryByLabelText("Team ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project ID")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    expect(screen.getByRole("heading", { name: "Connect E2B" })).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect Vercel Sandbox" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Daytona/ }));
    expect(screen.getByRole("heading", { name: "Connect Daytona" })).toBeVisible();
    expect(screen.getByLabelText("API URL (optional)")).toBeVisible();
    expect(screen.getByLabelText("Target (optional)")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();
  });

  it("defaults Settings to the active provider", () => {
    renderSection({ settings: sandboxSettings({ vercel: vercelConnection }) });

    expect(screen.getByRole("radio", { name: /Vercel Sandbox/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect Vercel Sandbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Daytona" })).not.toBeInTheDocument();
  });

  it.each([
    ["API URL (optional)", "https://daytona.example.test/api"],
    ["Target (optional)", "draft-target"],
  ])(
    "keeps the Daytona %s draft guarded after selecting another provider",
    async (label, value) => {
      const user = userEvent.setup();
      const { onDraftStateChange } = renderSection({
        settings: sandboxSettings({ daytona: daytonaConnection }),
        variant: "onboarding",
      });
      const daytona = screen.getByRole("radio", { name: /Daytona/ });
      const e2b = screen.getByRole("radio", { name: /E2B/ });
      expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false });

      await user.click(daytona);
      await user.click(screen.getByRole("button", { name: "Replace connection" }));
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
      await user.type(screen.getByLabelText("API key"), "synthetic-daytona-key");
      await user.click(e2b);
      expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: false });

      await user.click(daytona);
      await user.click(screen.getByRole("button", { name: "Replace connection" }));
      expect(screen.getByLabelText(label)).toHaveValue(value);
      expect(screen.getByLabelText("API key")).toHaveValue("");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false });
    },
  );
});

describe("SandboxProviderSection saves", () => {
  const cases: Array<{
    body: Record<string, string>;
    connection: SandboxConnectionPreviews[SandboxProvider];
    fields: Array<[label: string, value: string]>;
    label: string;
    provider: SandboxProvider;
  }> = [
    {
      body: { projectId: "prj_new", teamId: "team_new", token: "vca_new" },
      connection: vercelConnection,
      fields: [
        ["Token", "vca_new"],
        ["Team ID", "team_new"],
        ["Project ID", "prj_new"],
      ],
      label: "Vercel Sandbox",
      provider: "vercel",
    },
    {
      body: { apiKey: "e2b_new" },
      connection: e2bConnection,
      fields: [["API key", "e2b_new"]],
      label: "E2B",
      provider: "e2b",
    },
    {
      body: {
        apiKey: "daytona_new",
        apiUrl: "https://app.daytona.io/api",
        target: "us",
      },
      connection: daytonaConnection,
      fields: [
        ["API key", "daytona_new"],
        ["API URL (optional)", "https://app.daytona.io/api"],
        ["Target (optional)", "us"],
      ],
      label: "Daytona",
      provider: "daytona",
    },
  ];

  it.each(cases)("saves $label through its provider-specific route", async (testCase) => {
    const user = userEvent.setup();
    const settings = sandboxSettings();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connection: testCase.connection }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const { onSettingsChange, setFlashMessage } = renderSection({ settings });

    await user.click(screen.getByRole("radio", { name: new RegExp(testCase.label) }));
    if (testCase.provider === "vercel") {
      await user.click(screen.getByRole("button", { name: "Enter IDs manually" }));
    }
    for (const [label, value] of testCase.fields) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/sandbox-connections/${testCase.provider}`,
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(testCase.body);
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      connections: { ...settings.connections, [testCase.provider]: testCase.connection },
    });
    expect(setFlashMessage).toHaveBeenCalledWith({
      kind: "success",
      text: `${testCase.label} connection saved.`,
    });
  });

  it("locks Daytona fields during a save and preserves the draft after failure", async () => {
    const user = userEvent.setup();
    let resolveSave!: (response: Response) => void;
    const deferredSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave);
    const { onDraftStateChange, onSettingsChange, setFlashMessage } = renderSection({
      variant: "onboarding",
    });

    await user.click(screen.getByRole("radio", { name: /Daytona/ }));
    const fields = [
      [screen.getByLabelText("API key"), "synthetic-daytona-key"],
      [screen.getByLabelText("API URL (optional)"), "https://daytona.example.test/api"],
      [screen.getByLabelText("Target (optional)"), "draft-target"],
    ] as const;
    for (const [input, value] of fields) await user.type(input, value);

    const save = screen.getByRole("button", { name: "Save connection" });
    await user.click(save);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(save).toBeDisabled();
    for (const [input] of fields) expect(input).toBeDisabled();
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: true });

    resolveSave(Response.json({ error: "Validation failed." }, { status: 422 }));
    await waitFor(() => expect(save).toBeEnabled());
    expect(setFlashMessage).toHaveBeenCalledWith({ kind: "error", text: "Validation failed." });
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: false });
    for (const [input, value] of fields) {
      expect(input).toBeEnabled();
      expect(input).toHaveValue(value);
    }
  });
});

describe("Vercel target discovery", () => {
  const northwind = { id: "team_123", name: "Northwind", slug: "northwind" };
  const acme = { id: "team_other", name: "acme", slug: "acme" };
  const lookupUrl = `/api/workspaces/${workspaceId}/sandbox-connections/vercel/targets`;

  it("restores a saved target by name and scopes projects to the chosen team", async () => {
    const user = userEvent.setup();
    const saveRequest = Promise.withResolvers<Response>();
    const requests = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ teams: [northwind, acme] }))
      .mockResolvedValueOnce(
        Response.json({
          projects: [
            { id: "prj_other", name: "Other runner" },
            { id: "prj_123", name: "Wallie runner" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ projects: [{ id: "prj_acme", name: "Acme runner" }] }))
      .mockReturnValueOnce(saveRequest.promise);
    const { onSettingsChange } = renderSection({
      settings: sandboxSettings({ vercel: vercelConnection }),
      stateful: true,
    });

    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    await user.type(screen.getByLabelText("Token"), "synthetic-token");
    await user.click(screen.getByRole("button", { name: "Find teams" }));

    const team = await screen.findByRole("combobox", { name: "Team" });
    const form = team.closest("form")!;
    expect(team).toHaveTextContent("Northwind · northwind");
    expect(new FormData(form).get("vercel-team")).toBe("team_123");
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("prj_123");

    await user.click(screen.getByText("Team", { selector: "label" }));
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByRole("option", { name: "Northwind · northwind" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(listbox).getByRole("option", { name: "acme" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(team).toHaveFocus();

    await user.keyboard("{Enter}{Enter}");
    expect(requests).toHaveBeenCalledTimes(2);
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(team).toHaveFocus();
    expect(team).toHaveTextContent("acme");
    expect(new FormData(form).get("vercel-team")).toBe("team_other");
    expect(await screen.findByRole("option", { name: "Acme runner · acme" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Wallie runner · northwind" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("prj_acme");
    expect(
      requests.mock.calls.map(([url, init]) => [
        url,
        init?.method,
        JSON.parse(init!.body as string),
      ]),
    ).toEqual([
      [lookupUrl, "POST", { token: "synthetic-token" }],
      [lookupUrl, "POST", { token: "synthetic-token", teamId: "team_123" }],
      [lookupUrl, "POST", { token: "synthetic-token", teamId: "team_other" }],
    ]);
    expect(onSettingsChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save connection" }));
    expect(JSON.parse(requests.mock.calls[3]![1]!.body as string)).toEqual({
      projectId: "prj_acme",
      teamId: "team_other",
      token: "synthetic-token",
    });
    expect(team).toBeDisabled();
    expect(new FormData(form).has("vercel-team")).toBe(false);
    await user.click(team);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await act(async () =>
      saveRequest.resolve(
        Response.json({
          connection: { ...vercelConnection, teamId: "team_other", projectId: "prj_acme" },
        }),
      ),
    );
    expect(onSettingsChange).toHaveBeenCalledOnce();
  });

  it("aborts stale project lookups when onboarding changes or clears the team", async () => {
    const user = userEvent.setup();
    const stale = Promise.withResolvers<Response>();
    const cleared = Promise.withResolvers<Response>();
    const requests = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ teams: [northwind, acme] }))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(Response.json({ projects: [{ id: "prj_acme", name: "Acme runner" }] }))
      .mockReturnValueOnce(cleared.promise);
    const { onSettingsChange } = renderSection({ variant: "onboarding" });

    await user.click(screen.getByRole("radio", { name: /Vercel Sandbox/ }));
    await user.type(screen.getByLabelText("Token"), "synthetic-token");
    await user.click(screen.getByRole("button", { name: "Find teams" }));
    const team = await screen.findByRole("combobox", { name: "Team" });
    const save = screen.getByRole("button", { name: "Save connection" });
    expect(team).toHaveTextContent("Choose a team");
    expect(requests).toHaveBeenCalledOnce();

    await user.click(team);
    await user.click(screen.getByRole("option", { name: "Northwind · northwind" }));
    const staleSignal = requests.mock.calls[1]?.[1]?.signal;
    expect(staleSignal?.aborted).toBe(false);
    expect(team).toBeEnabled();
    await user.click(team);
    await user.click(screen.getByRole("option", { name: "acme" }));
    expect(staleSignal?.aborted).toBe(true);
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("prj_acme");

    const staleProjects = { projects: [{ id: "prj_stale", name: "Stale runner" }] };
    await act(async () => stale.resolve(Response.json(staleProjects)));
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("prj_acme");

    await user.click(team);
    await user.click(screen.getByRole("option", { name: "Northwind · northwind" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    const clearedSignal = requests.mock.calls[3]?.[1]?.signal;
    expect(clearedSignal?.aborted).toBe(false);
    await user.click(team);
    await user.click(screen.getByRole("option", { name: "Choose a team" }));
    expect(clearedSignal?.aborted).toBe(true);
    await act(async () => cleared.resolve(Response.json(staleProjects)));
    expect(new FormData(team.closest("form")!).get("vercel-team")).toBe("");
    expect(team).toHaveTextContent("Choose a team");
    expect(screen.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading projects…")).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(requests).toHaveBeenCalledTimes(4);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("hides Team for an empty result and automatically selects a lone team", async () => {
    const user = userEvent.setup();
    const requests = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ teams: [] }))
      .mockResolvedValueOnce(Response.json({ teams: [northwind] }))
      .mockResolvedValueOnce(
        Response.json({ projects: [{ id: "prj_123", name: "Wallie runner" }] }),
      );
    renderSection();

    await user.type(screen.getByLabelText("Token"), "synthetic-token");
    const find = screen.getByRole("button", { name: "Find teams" });
    await user.click(find);
    expect(await screen.findByText(/No teams found/)).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Team" })).not.toBeInTheDocument();
    expect(requests).toHaveBeenCalledOnce();

    await user.click(find);
    expect(await screen.findByRole("combobox", { name: "Team" })).toHaveTextContent(
      "Northwind · northwind",
    );
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("prj_123");
    expect(requests).toHaveBeenCalledTimes(3);
    expect(requests).toHaveBeenLastCalledWith(
      lookupUrl,
      expect.objectContaining({
        body: JSON.stringify({ token: "synthetic-token", teamId: "team_123" }),
      }),
    );
  });

  it("requires reselection when the saved project is missing and preserves the manual target", async () => {
    const user = userEvent.setup();
    const requests = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ teams: [northwind] }))
      .mockResolvedValueOnce(
        Response.json({ projects: [{ id: "prj_replacement", name: "New runner" }] }),
      );
    const { onSettingsChange } = renderSection({
      settings: sandboxSettings({ vercel: { ...vercelConnection, projectName: null } }),
      variant: "onboarding",
    });
    expect(screen.getByText("Connected project · name unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Test capabilities" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    await user.type(screen.getByLabelText("Token"), "synthetic-token");
    await user.click(screen.getByRole("button", { name: "Find teams" }));
    expect(await screen.findByText(/Saved project unavailable/)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Enter IDs manually" }));
    expect(screen.getByRole("link", { name: /Team ID from Team Settings/ })).toHaveAttribute(
      "href",
      expect.stringContaining("find-your-team-id"),
    );
    expect(screen.getByLabelText("Project ID")).toHaveValue("prj_123");
    expect(requests).toHaveBeenCalledTimes(2);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });
});

describe("SandboxProviderSection disconnect confirmation", () => {
  it("requires selecting an inactive provider and restores focus after keyboard dismissal", async () => {
    const user = userEvent.setup();
    renderSection({
      settings: sandboxSettings({ e2b: e2bConnection, vercel: vercelConnection }),
    });

    expect(screen.queryByRole("button", { name: "Disconnect E2B" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect Vercel Sandbox" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    const trigger = screen.getByRole("button", { name: "Disconnect E2B" });
    await user.click(trigger);

    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect E2B?" });
    expect(dialog).toHaveAccessibleDescription(
      "Disconnecting E2B removes its saved connection from this workspace. Wallie will continue using Vercel Sandbox.",
    );
    expect((await axe.run(document.body, axeOptions)).violations).toEqual([]);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("blocks dismissal while pending, then clears only the disconnected provider", async () => {
    const user = userEvent.setup();
    const settings = sandboxSettings({ e2b: e2bConnection, vercel: vercelConnection });
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { onSettingsChange, setFlashMessage } = renderSection({ settings });

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    const trigger = screen.getByRole("button", { name: "Disconnect E2B" });
    await user.click(trigger);
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect E2B?" });
    await user.click(within(dialog).getByRole("button", { name: "Disconnect E2B" }));

    expect(await screen.findByRole("button", { name: "Disconnecting…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog", { name: "Disconnect E2B?" })).toBeVisible();

    resolveRequest?.(
      new Response(JSON.stringify({ connection: null }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Disconnect E2B?" })).toBeNull(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/sandbox-connections/e2b`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      connections: { ...settings.connections, e2b: null },
    });
    expect(setFlashMessage).toHaveBeenCalledWith({ kind: "success", text: "E2B disconnected." });
    expect(trigger).toHaveFocus();
  });

  it("keeps a failed disconnect visible and retryable", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Connection changed. Retry." }), {
          headers: { "content-type": "application/json" },
          status: 409,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ connection: null }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    const { onSettingsChange, setFlashMessage } = renderSection({
      settings: sandboxSettings({ daytona: daytonaConnection, vercel: vercelConnection }),
    });

    await user.click(screen.getByRole("radio", { name: /Daytona/ }));
    await user.click(screen.getByRole("button", { name: "Disconnect Daytona" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect Daytona?" });
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Daytona" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Connection changed. Retry.",
    );
    expect(screen.getByRole("alertdialog", { name: "Disconnect Daytona?" })).toBeVisible();
    expect(setFlashMessage).toHaveBeenCalledWith({
      kind: "error",
      text: "Connection changed. Retry.",
    });

    await user.click(screen.getByRole("button", { name: "Disconnect Daytona" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onSettingsChange).toHaveBeenCalledOnce();
  });
});

describe("SandboxProviderSection saved connections", () => {
  it("shows masked previews, dates, and provider metadata without secret inputs", async () => {
    const user = userEvent.setup();
    renderSection({
      settings: sandboxSettings({
        daytona: daytonaConnection,
        e2b: e2bConnection,
        vercel: vercelConnection,
      }),
    });

    expect(screen.getByRole("heading", { level: 2, name: "Sandbox" })).toBeVisible();
    const heading = screen.getByRole("heading", { name: "Vercel Sandbox connected" });
    const testCapabilities = screen.getByRole("link", { name: "Test capabilities" });
    const replaceConnection = screen.getByRole("button", { name: "Replace connection" });
    const disconnectGuidance = screen.getByText(
      "Switch to another connected provider before disconnecting this one.",
    );
    const header = heading.parentElement?.parentElement;

    expect(heading).toBeVisible();
    expect(header).toContainElement(testCapabilities);
    expect(header).toContainElement(replaceConnection);
    expect(header).not.toContainElement(disconnectGuidance);
    expect(screen.getByText("vca_…1234")).toBeVisible();
    expect(screen.getByText(updatedLabel)).toBeVisible();
    expect(screen.getByText("Project: wallie-sandboxes")).toBeVisible();
    expect(screen.getByText("Team ID")).not.toBeVisible();
    await user.click(screen.getByText("Connection details"));
    expect(screen.getByText("Team ID")).toBeVisible();
    expect(screen.getByText("team_123")).toBeVisible();
    expect(screen.getByText("Project ID")).toBeVisible();
    expect(screen.getByText("prj_123")).toBeVisible();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
    expect(disconnectGuidance).toBeVisible();
    expect(testCapabilities).toHaveAttribute("href", "#verify");
    expect(
      screen.queryByRole("button", { name: "Disconnect Vercel Sandbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this provider" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    expect(screen.getByRole("heading", { name: "E2B connected" })).toBeVisible();
    expect(screen.getByText("e2b_…1234")).toBeVisible();
    expect(screen.getAllByText(updatedLabel).length).toBeGreaterThan(0);
    expect(screen.queryByText("Team ID")).not.toBeInTheDocument();
    expect(screen.queryByText("API URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this provider" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect E2B" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Test capabilities" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Switch to another connected provider before disconnecting this one."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Daytona/ }));
    expect(screen.getByRole("heading", { name: "Daytona connected" })).toBeVisible();
    expect(screen.getByText("daytona_…1234")).toBeVisible();
    expect(screen.getByText("API URL")).toBeVisible();
    expect(screen.getByText("https://app.daytona.io/api")).toBeVisible();
    expect(screen.getByText("Target")).toBeVisible();
    expect(screen.getByText("us")).toBeVisible();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this provider" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect Daytona" })).toBeEnabled();
  });

  it("keeps an unconfigured provider on its initial connection form", async () => {
    const user = userEvent.setup();
    renderSection({ settings: sandboxSettings({ vercel: vercelConnection }) });

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    expect(screen.getByRole("heading", { name: "Configure E2B" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect E2B" })).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save connection" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace connection" })).not.toBeInTheDocument();
  });

  it("replaces a saved connection in place and can cancel without mutation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderSection({ settings: sandboxSettings({ vercel: vercelConnection }) });

    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    expect(screen.getByRole("heading", { name: "Connect Vercel Sandbox" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Vercel Sandbox connected" }),
    ).not.toBeInTheDocument();
    const token = screen.getByLabelText("Token");
    expect(token).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Enter IDs manually" }));
    expect(screen.getByLabelText("Team ID")).toHaveValue("team_123");
    expect(screen.getByLabelText("Project ID")).toHaveValue("prj_123");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();

    await user.type(token, "secret-should-not-leak");
    await user.clear(screen.getByLabelText("Team ID"));
    await user.type(screen.getByLabelText("Team ID"), "team_draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
    expect(screen.getByText("vca_…1234")).toBeVisible();
    await user.click(screen.getByText("Connection details"));
    expect(screen.getByText("team_123")).toBeVisible();
    expect(screen.queryByText("team_draft")).not.toBeInTheDocument();
    expect(screen.queryByText("secret-should-not-leak")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    expect(screen.getByLabelText("Token")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Enter IDs manually" }));
    expect(screen.getByLabelText("Team ID")).toHaveValue("team_123");
  });

  it("returns to an updated summary after a successful replacement", async () => {
    const user = userEvent.setup();
    const updatedConnection = {
      ...vercelConnection,
      projectId: "prj_new",
      teamId: "team_new",
      tokenPreview: "vca_…9999",
      updatedAt: "2026-08-15T18:00:00.000Z",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connection: updatedConnection }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    renderSection({ settings: sandboxSettings({ vercel: vercelConnection }), stateful: true });

    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    await user.click(screen.getByRole("button", { name: "Enter IDs manually" }));
    await user.type(screen.getByLabelText("Token"), "vca_new");
    await user.clear(screen.getByLabelText("Team ID"));
    await user.type(screen.getByLabelText("Team ID"), "team_new");
    await user.clear(screen.getByLabelText("Project ID"));
    await user.type(screen.getByLabelText("Project ID"), "prj_new");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(await screen.findByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
    expect(screen.getByText("vca_…9999")).toBeVisible();
    await user.click(screen.getByText("Connection details"));
    expect(screen.getByText("team_new")).toBeVisible();
    expect(screen.getByText("prj_new")).toBeVisible();
    expect(screen.getByText("Updated Aug 15, 2026")).toBeVisible();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
    expect(screen.queryByText("vca_new")).not.toBeInTheDocument();
  });

  it("activates a connected non-active provider without a reload", async () => {
    const user = userEvent.setup();
    const settings = sandboxSettings({ e2b: e2bConnection, vercel: vercelConnection });
    const activated: SandboxSettingsResponse = {
      ...settings,
      activeProvider: "e2b",
      revision: 2,
      updatedAt: timestamp,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(activated), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const { onSettingsChange, setFlashMessage } = renderSection({ settings, stateful: true });

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(activated));
    expect(setFlashMessage).toHaveBeenCalledWith({
      kind: "success",
      text: "E2B is now active.",
    });
    expect(screen.getByRole("link", { name: "Test capabilities" })).toHaveAttribute(
      "href",
      "#verify",
    );
    expect(
      screen.getByText("Switch to another connected provider before disconnecting this one."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Disconnect E2B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this provider" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Vercel Sandbox/ }));
    expect(screen.getByRole("button", { name: "Use this provider" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect Vercel Sandbox" })).toBeEnabled();
  });

  it("clears a disconnected provider back to the unconfigured form", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connection: null }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    renderSection({
      settings: sandboxSettings({ e2b: e2bConnection, vercel: vercelConnection }),
      stateful: true,
    });

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    await user.click(screen.getByRole("button", { name: "Disconnect E2B" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect E2B?" });
    await user.click(within(dialog).getByRole("button", { name: "Disconnect E2B" }));

    expect(await screen.findByRole("heading", { name: "Connect E2B" })).toBeVisible();
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "E2B connected" })).not.toBeInTheDocument();
    expect(screen.queryByText("e2b_…1234")).not.toBeInTheDocument();
  });

  it("hides management actions when the viewer cannot manage the workspace", () => {
    renderSection({
      canManage: false,
      settings: sandboxSettings({ e2b: e2bConnection, vercel: vercelConnection }),
    });

    expect(screen.getByRole("heading", { name: "Vercel Sandbox connected" })).toBeVisible();
    expect(screen.getByText("vca_…1234")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Replace connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this provider" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument();
  });
});
