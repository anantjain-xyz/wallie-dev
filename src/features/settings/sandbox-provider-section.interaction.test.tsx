// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
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

function renderSection({
  settings = sandboxSettings(),
  variant,
}: {
  settings?: SandboxSettingsResponse;
  variant?: "onboarding" | "settings";
} = {}) {
  const onSettingsChange = vi.fn();
  const setFlashMessage = vi.fn();

  render(
    <OverlayProvider>
      <SandboxProviderSection
        canManage
        onSettingsChange={onSettingsChange}
        setFlashMessage={setFlashMessage}
        settings={settings}
        variant={variant}
        vercelConnection={settings.connections.vercel}
        workspaceId={workspaceId}
      />
    </OverlayProvider>,
  );

  return { onSettingsChange, setFlashMessage };
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
    expect(screen.getByLabelText("Team id")).toBeVisible();
    expect(screen.getByLabelText("Project id")).toBeVisible();

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
    expect(screen.getByRole("heading", { name: "Connect Vercel Sandbox" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Daytona" })).not.toBeInTheDocument();
  });
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
        ["Team id", "team_new"],
        ["Project id", "prj_new"],
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
    for (const [label, value] of testCase.fields) {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/sandbox-connections/${testCase.provider}`,
      expect.objectContaining({
        body: JSON.stringify(testCase.body),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      connections: { ...settings.connections, [testCase.provider]: testCase.connection },
    });
    expect(setFlashMessage).toHaveBeenCalledWith({
      kind: "success",
      text: `${testCase.label} connection saved.`,
    });
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
