// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsExportControls } from "./analytics-export-controls";

const workspaceId = "58200000-0000-4000-8000-000000000001";
const factoryId = "58200000-0000-4000-8000-000000000002";
const exportId = "58200000-0000-4000-8000-000000000003";
const path = "/api/workspaces/" + workspaceId + "/factories/" + factoryId + "/analytics-exports";
const filters = {
  from: "2026-11-01",
  to: "2026-11-07",
  compare: "previous",
  dimension: "model",
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("analytics export controls", () => {
  it("waits for an explicit capture, retains its request ID on retry, and offers both formats for one snapshot", async () => {
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_path: string, request: RequestInit) => {
      requests.push(JSON.parse(String(request.body)));
      if (requests.length === 1) throw new Error("Connection lost after capture");
      return Response.json({
        id: exportId,
        createdAt: "2026-11-19T00:00:00.123456Z",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <AnalyticsExportControls workspaceId={workspaceId} factoryId={factoryId} filters={filters} />,
    );
    expect(fetch).not.toHaveBeenCalled();

    const capture = screen.getByRole("button", { name: "Create export snapshot" });
    fireEvent.click(capture);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    fireEvent.click(capture);

    expect(await screen.findByRole("link", { name: "Download CSV" })).toHaveAttribute(
      "href",
      path + "/" + exportId + "?format=csv",
    );
    expect(screen.getByRole("link", { name: "Download JSON" })).toHaveAttribute(
      "href",
      path + "/" + exportId + "?format=json",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      ...filters,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(requests[0]).toEqual(requests[1]);
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST" }));
  });
  it.each(["expired", "unavailable"])("offers recovery for an %s snapshot", async (state) => {
    const fetch = vi.fn(async (input: string) =>
      input.endsWith("?format=json")
        ? new Response(null, { status: 404 })
        : Response.json({
            id: exportId,
            createdAt: "2026-11-19T00:00:00Z",
            expiresAt: new Date(Date.now() + (state === "expired" ? -1 : 86_400_000)).toISOString(),
          }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <AnalyticsExportControls workspaceId={workspaceId} factoryId={factoryId} filters={filters} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create export snapshot" }));
    if (state === "unavailable") {
      fireEvent.click(await screen.findByRole("link", { name: "Download JSON" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This snapshot is no longer available",
      );
    } else {
      expect(await screen.findByRole("status")).toHaveTextContent("Snapshot expired");
    }
    expect(screen.getByRole("button", { name: "Create a new snapshot" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
  });
});
