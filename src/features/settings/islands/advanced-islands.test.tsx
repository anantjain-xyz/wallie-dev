// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaintenanceIsland } from "@/features/settings/islands/advanced-islands";
import type { MaintenanceTickResponse } from "@/lib/maintenance/service";

const delegatedResult: MaintenanceTickResponse = {
  cleanup: {
    activeProviderSandboxCount: 0,
    reapedSandboxIds: [],
    retriedJobIds: [],
    stalledRunIds: [],
    stoppedSandboxIds: [],
    terminalErroredJobIds: [],
  },
  processing: {
    processedJobIds: [],
    result: "delegated",
    runId: null,
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(delegatedResult)));

    const { container } = render(<MaintenanceIsland canManage workspaceId="workspace-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Run maintenance" }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent(
      "Maintenance complete. No stuck work was found; queued jobs remain with the worker.",
    );

    const island = container.firstElementChild;
    expect(island).toHaveClass("mt-6");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run maintenance" })).toBeEnabled(),
    );
  });

  it("does not add an empty spacing wrapper for non-managers", () => {
    const { container } = render(<MaintenanceIsland canManage={false} workspaceId="workspace-1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
