// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SettingsPageData } from "@/features/settings/data";
import { MaintenanceIsland, VerifySetupIsland } from "@/features/settings/islands/advanced-islands";
import {
  dispatchSettingsDataChanged,
  registerSettingsDataReplayConsumer,
  replaySettingsDataChanges,
} from "@/features/settings/settings-island-events";
import type { MaintenanceTickResponse } from "@/lib/maintenance/contracts";

vi.mock("@/features/settings/verify-setup-section", () => ({
  VerifySetupSection: ({ data }: { data: SettingsPageData }) => (
    <output>
      {data.setupHealth.githubInstallation.connected ? "GitHub connected" : "GitHub blocked"}
    </output>
  ),
}));

const maintenanceResult: MaintenanceTickResponse = {
  githubVerification: { checked: 0, refreshed: 0, failed: 0 },
  cleanup: {
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

    render(<MaintenanceIsland canManage workspaceId="workspace-1" workspaceName="Acme Lab" />);

    expect(screen.getByText("Acme Lab")).toBeInTheDocument();
    expect(screen.getByText(/worker handles orphaned sandboxes separately/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Maintenance pass finished.");
    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Maintenance" })).not.toBeInTheDocument();
    expect(document.getElementById("maintenance")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run maintenance" })).toBeEnabled(),
    );
  });

  it("reports known counts alongside failures, throttling, and bounded results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...maintenanceResult,
          cleanup: null,
          reconciliation: { checked: 4, canceled: 2, rateLimited: true },
          githubVerification: { checked: 3, refreshed: 1, failed: 1, limited: true },
        }),
      ),
    );
    render(<MaintenanceIsland canManage workspaceId="workspace-1" workspaceName="Acme Lab" />);

    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Maintenance returned partial results.");
    expect(result).toHaveTextContent("Stalled-job recovery did not finish.");
    expect(result).toHaveTextContent("Linear paused checks because of its rate limit.");
    expect(result).toHaveTextContent("GitHub verification failed for 1 pull request.");
    expect(result).toHaveTextContent("Some GitHub checks could not be saved.");
    expect(result).toHaveTextContent("GitHub reached its per-run limit.");
    expect(screen.queryByText("Jobs queued for retry")).not.toBeInTheDocument();
    const archiveCell = screen.getByText("Linear-linked sessions archived").parentElement!;
    expect(within(archiveCell).getByText("2")).toBeInTheDocument();
  });

  it("clears the old cards when a rerun starts and does not show them after a failure", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(maintenanceResult));
    let finish!: (response: Response) => void;
    request.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", request);
    render(<MaintenanceIsland canManage workspaceId="workspace-1" workspaceName="Acme Lab" />);

    const run = screen.getByRole("button", { name: "Run maintenance" });
    fireEvent.click(run);
    expect(await screen.findByText("Jobs queued for retry")).toBeInTheDocument();
    fireEvent.click(run);
    expect(run).toHaveTextContent("Running…");
    expect(screen.queryByText("Jobs queued for retry")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    finish(Response.json({ error: "Rate limit exceeded. Please retry later." }, { status: 429 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please retry later");
    expect(screen.queryByText("Jobs queued for retry")).not.toBeInTheDocument();
  });

  it("does not add an empty spacing wrapper for non-managers", () => {
    const { container } = render(
      <MaintenanceIsland canManage={false} workspaceId="workspace-1" workspaceName="Acme Lab" />,
    );

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
