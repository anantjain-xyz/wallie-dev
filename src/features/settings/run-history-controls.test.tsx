// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunHistoryControls } from "@/features/settings/run-history-controls";
import type { RunExportSummary } from "@/lib/run-exports/contracts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const exportId = "00000000-0000-4000-8000-000000000002";
const queued: RunExportSummary = {
  id: exportId,
  requestedAt: "2026-11-15T00:00:00+00:00",
  snapshotAt: null,
  completedAt: null,
  expiresAt: "2026-11-16T00:00:00+00:00",
  status: "queued",
  itemCount: 0,
  processedCount: 0,
};

const retention = { transcriptDays: null, evidenceDays: 90, contextDays: 120 };
const retentionUrl = `/api/workspaces/${workspaceId}/run-retention`;
const exportsUrl = `/api/workspaces/${workspaceId}/run-exports`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(handlers: (url: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => handlers(url, init));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  const { container } = render(
    <main>
      <RunHistoryControls workspaceId={workspaceId} />
    </main>,
  );
  return { container, fetch, user };
}

describe("run history settings", () => {
  it("saves explicit limits and exposes downloads for completed exports only", async () => {
    const { container, fetch, user } = setup((url, init) => {
      if (url === retentionUrl) {
        return Response.json({
          retention: init?.method === "PUT" ? { ...retention, transcriptDays: 30 } : retention,
        });
      }
      return Response.json({
        exports: [
          { ...queued, status: "completed" },
          { ...queued, id: workspaceId, status: "expired" },
        ],
      });
    });

    const transcript = await screen.findByRole("spinbutton", {
      name: "Transcript retention (days)",
    });
    expect(transcript).toHaveValue(null);
    expect(
      screen.getByRole("spinbutton", { name: "Validation evidence retention (days)" }),
    ).toHaveValue(90);
    await user.type(transcript, "30");
    await user.click(screen.getByRole("button", { name: "Save retention" }));
    expect(await screen.findByText("Retention saved.", { exact: false })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      retentionUrl,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ transcriptDays: 30, evidenceDays: 90, contextDays: 120 }),
      }),
    );
    expect(screen.getByRole("link", { name: "Download manifest" })).toHaveAttribute(
      "href",
      `${exportsUrl}/${exportId}`,
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toHaveProperty("violations", []);
  });

  it("reuses the request id after an uncertain export response", async () => {
    let attempts = 0;
    const { fetch, user } = setup((url, init) => {
      if (url === retentionUrl) return Response.json({ retention });
      if (init?.method !== "POST") return Response.json({ exports: attempts > 1 ? [queued] : [] });
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "Export response lost." }, { status: 503 })
        : Response.json({ export: queued }, { status: 202 });
    });
    const button = await screen.findByRole("button", { name: "Request export" });
    await screen.findByText("No exports yet.");
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Export response lost.");
    await user.click(button);
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(button).toBeDisabled();
    const submissions = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.[1]?.body).toBe(submissions[1]?.[1]?.body);
  });
});
