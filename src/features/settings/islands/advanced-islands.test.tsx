// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsPageData } from "@/features/settings/data";
import { MaintenanceIsland, VerifySetupIsland } from "@/features/settings/islands/advanced-islands";
import {
  dispatchSettingsDataChanged,
  registerSettingsDataReplayConsumer,
  replaySettingsDataChanges,
} from "@/features/settings/settings-island-events";
import type { MaintenanceTickResponse } from "@/lib/maintenance/service";

vi.mock("@/features/settings/verify-setup-section", () => ({
  VerifySetupSection: ({ data }: { data: SettingsPageData }) => (
    <output>
      {data.setupHealth.githubInstallation.connected ? "GitHub connected" : "GitHub blocked"}
    </output>
  ),
}));

const maintenanceResult: MaintenanceTickResponse = {
  cleanup: {
    activeProviderSandboxCount: 0,
    reapedSandboxIds: [],
    retriedJobIds: [],
    stalledRunIds: [],
    stoppedSandboxIds: [],
    terminalErroredJobIds: [],
  },
  reconciliation: {
    canceled: 0,
    checked: 0,
    rateLimited: false,
  },
};

describe("MaintenanceIsland", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the maintenance result separated from the usage summary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(maintenanceResult)));

    const { container } = render(<MaintenanceIsland canManage workspaceId="workspace-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent(
      "Maintenance complete. No stuck work was found; queued jobs remain with the worker.",
    );
    expect(screen.queryByText("Processing")).not.toBeInTheDocument();

    const island = container.firstElementChild;
    expect(island).toHaveAttribute("id", "maintenance");
    expect(island).toHaveClass("scroll-mt-8");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run maintenance" })).toBeEnabled(),
    );
  });

  it("does not add an empty spacing wrapper for non-managers", () => {
    const { container } = render(<MaintenanceIsland canManage={false} workspaceId="workspace-1" />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("VerifySetupIsland", () => {
  it("applies integration data updates without a page reload", () => {
    const initialData = {
      setupHealth: { githubInstallation: { connected: false } },
      workspace: { id: "workspace-live" },
    } as SettingsPageData;

    render(<VerifySetupIsland initialData={initialData} />);

    act(() => {
      dispatchSettingsDataChanged("workspace-live", (current: SettingsPageData) => ({
        ...current,
        setupHealth: {
          ...current.setupHealth,
          githubInstallation: {
            ...current.setupHealth.githubInstallation,
            connected: true,
          },
        },
      }));
    });

    expect(screen.getByText("GitHub connected")).toBeInTheDocument();
  });

  it("replays integration updates that happen before the island mounts", () => {
    dispatchSettingsDataChanged("workspace-late", (current: SettingsPageData) => ({
      ...current,
      setupHealth: {
        ...current.setupHealth,
        githubInstallation: {
          ...current.setupHealth.githubInstallation,
          connected: true,
        },
      },
    }));

    render(
      <VerifySetupIsland
        initialData={
          {
            setupHealth: { githubInstallation: { connected: false } },
            workspace: { id: "workspace-late" },
          } as SettingsPageData
        }
      />,
    );

    expect(screen.getByText("GitHub connected")).toBeInTheDocument();
  });

  it("expires replayed updates after the pending islands consume them", () => {
    const initialData = {
      setupHealth: { githubInstallation: { connected: false } },
      workspace: { id: "workspace-consumed" },
    } as SettingsPageData;
    dispatchSettingsDataChanged("workspace-consumed", (current: SettingsPageData) => ({
      ...current,
      setupHealth: {
        ...current.setupHealth,
        githubInstallation: {
          ...current.setupHealth.githubInstallation,
          connected: true,
        },
      },
    }));

    expect(
      replaySettingsDataChanges(initialData, "repository").setupHealth.githubInstallation.connected,
    ).toBe(true);
    expect(
      replaySettingsDataChanges(initialData, "verify-setup").setupHealth.githubInstallation
        .connected,
    ).toBe(true);

    const unregisterRepository = registerSettingsDataReplayConsumer(
      "workspace-consumed",
      "repository",
    );
    const unregisterVerifySetup = registerSettingsDataReplayConsumer(
      "workspace-consumed",
      "verify-setup",
    );
    unregisterRepository();
    unregisterVerifySetup();

    expect(
      replaySettingsDataChanges(initialData, "repository").setupHealth.githubInstallation.connected,
    ).toBe(false);
    expect(
      replaySettingsDataChanges(initialData, "verify-setup").setupHealth.githubInstallation
        .connected,
    ).toBe(false);
  });
});
