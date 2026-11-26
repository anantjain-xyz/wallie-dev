// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
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
    <PortalRootProvider>
      <main>
        <RunHistoryControls workspaceId={workspaceId} />
      </main>
    </PortalRootProvider>,
  );
  return { container, fetch, user };
}

describe("run history settings", () => {
  it(
    "waits for confirmation before applying the first finite limit and keeps downloads private",
    { timeout: 15_000 },
    async () => {
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
      expect(transcript).toHaveAccessibleDescription(/1–3,650 whole days, or leave blank/);
      await user.type(transcript, "30");
      const save = screen.getByRole("button", { name: "Save retention" });
      await user.click(save);
      const dialog = await screen.findByRole("alertdialog", { name: "Tighten retention limits?" });
      expect(dialog).toHaveTextContent("Transcripts: Keep indefinitely → 30 days");
      expect(dialog).toHaveAccessibleDescription(
        /appl(y|ies) to existing content.*in-progress and completed workspace exports/,
      );
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(save).toHaveFocus());
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
      await user.keyboard("{Enter}");
      await user.click(await screen.findByRole("button", { name: "Apply retention limits" }));
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
      await waitFor(() => expect(save).toHaveFocus());
      expect(
        await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
      ).toHaveProperty("violations", []);
    },
  );

  it("saves unchanged, extended, and indefinite limits without a confirmation", async () => {
    const { fetch, user } = setup((url, init) => {
      if (url === retentionUrl) {
        return Response.json({ retention: init?.body ? JSON.parse(String(init.body)) : retention });
      }
      return Response.json({ exports: [] });
    });
    const evidence = await screen.findByRole("spinbutton", {
      name: "Validation evidence retention (days)",
    });
    const context = screen.getByRole("spinbutton", { name: "Historical context retention (days)" });
    const save = screen.getByRole("button", { name: "Save retention" });
    await user.click(save);
    await screen.findByText("Retention saved.", { exact: false });
    await user.clear(evidence);
    await user.type(evidence, "180");
    await user.clear(context);
    await user.click(save);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await screen.findByText("Retention saved.", { exact: false });
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => init?.body),
    ).toEqual([
      JSON.stringify(retention),
      JSON.stringify({ ...retention, evidenceDays: 180, contextDays: null }),
    ]);
  });

  it("shows context-only tightening without an immediate export warning and keeps errors in the dialog", async () => {
    const { fetch, user } = setup((url, init) => {
      if (url !== retentionUrl) return Response.json({ exports: [] });
      return init?.method === "PUT"
        ? Response.json({ error: "Could not save run retention." }, { status: 503 })
        : Response.json({ retention });
    });
    const context = await screen.findByRole("spinbutton", {
      name: "Historical context retention (days)",
    });
    await user.clear(context);
    await user.type(context, "60");
    await user.click(screen.getByRole("button", { name: "Save retention" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Historical context: 120 days → 60 days");
    expect(dialog).not.toHaveTextContent("workspace exports");
    await user.click(within(dialog).getByRole("button", { name: "Apply retention limits" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not save run retention.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(context).toHaveValue(60);
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
