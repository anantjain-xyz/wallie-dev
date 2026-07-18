// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import type { SessionArtifactSummary } from "@/features/sessions/types";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const latestArtifact: SessionArtifactSummary = {
  createdAt: "2026-06-07T11:00:00.000Z",
  payload: "# Latest",
  stageSlug: "build",
  version: 2,
};

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

function renderPanel(overrides: Partial<Parameters<typeof ArtifactPanel>[0]> = {}) {
  return render(
    createElement(ArtifactPanel, {
      emptyText: "No artifact recorded for this stage.",
      initialFormattedArtifact: createElement("div", null, "Latest formatted"),
      initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
      isDrafting: false,
      latestArtifact,
      loadLatest: true,
      sessionId: SESSION_ID,
      stageSlug: "build",
      ...overrides,
    }),
  );
}

describe("ArtifactPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the server-formatted latest artifact without requesting history", async () => {
    renderPanel();

    expect(screen.getByText("Latest formatted")).toBeTruthy();
    expect(screen.queryByText("# Latest")).toBeNull();
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });

  it("loads metadata once on demand and fetches only uncached selected bodies", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            { createdAt: latestArtifact.createdAt, stageSlug: "build", version: 2 },
            { createdAt: "2026-06-07T10:00:00.000Z", stageSlug: "build", version: 1 },
          ],
        }),
      )
      .mockImplementationOnce(() =>
        response({
          artifact: {
            createdAt: "2026-06-07T10:00:00.000Z",
            payload: "# Earlier",
            sanitizedHtml: '<div class="text-[13px]"><h1>Earlier</h1></div>',
            stageSlug: "build",
            version: 1,
          },
        }),
      );

    fireEvent.click(renderPanel().getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: "v1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("version=");

    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    expect(await screen.findByText("Earlier")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain("version=1");

    fireEvent.click(screen.getByRole("tab", { name: "Artifact" }));
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("supports keyboard tab selection plus failure, retry, and empty states", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() => response({ error: "History unavailable" }, 500))
      .mockImplementationOnce(() => response({ artifacts: [] }));

    renderPanel();
    const artifactTab = screen.getByRole("tab", { name: "Artifact" });
    artifactTab.focus();
    fireEvent.keyDown(artifactTab, { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Versions" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect((await screen.findByRole("alert")).textContent).toContain("History unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No artifact versions recorded for this stage.")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts stale history requests when the selected stage changes", async () => {
    let firstSignal: AbortSignal | undefined;
    vi.mocked(fetch)
      .mockImplementationOnce((_input, init) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      })
      .mockImplementationOnce(() => response({ artifacts: [] }));

    const view = renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: false,
        latestArtifact: null,
        loadLatest: false,
        sessionId: SESSION_ID,
        stageSlug: "land",
      }),
    );

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
  });

  it("shows a same-stage latest artifact supplied by refreshed server props", async () => {
    const view = renderPanel();

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Third formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:3`,
        isDrafting: false,
        latestArtifact: {
          createdAt: "2026-06-07T12:00:00.000Z",
          payload: "# Third",
          stageSlug: "build",
          version: 3,
        },
        loadLatest: true,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    expect(await screen.findByText("Third formatted")).toBeTruthy();
    expect(screen.queryByText("Latest formatted")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reconciles cached metadata when realtime props add a version", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            { createdAt: latestArtifact.createdAt, stageSlug: "build", version: 2 },
            { createdAt: "2026-06-07T10:00:00.000Z", stageSlug: "build", version: 1 },
          ],
        }),
      )
      .mockImplementationOnce(() =>
        response({
          artifact: {
            ...latestArtifact,
            sanitizedHtml: "<h1>Latest</h1>",
          },
        }),
      );
    const view = renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: "v1" });
    fireEvent.click(screen.getByRole("tab", { name: "Artifact" }));

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: false,
        latestArtifact: {
          createdAt: "2026-06-07T12:00:00.000Z",
          payload: { newest: true },
          stageSlug: "build",
          version: 3,
        },
        loadLatest: true,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    expect(await screen.findByText(/"newest": true/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByRole("button", { name: "v3" })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("version=");
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain("version=2");
  });

  it("keeps a loaded prior-stage artifact cached when initial props omit it", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      response({
        artifact: {
          createdAt: "2026-06-07T09:00:00.000Z",
          payload: "# Planned",
          sanitizedHtml: "<h1>Planned</h1>",
          stageSlug: "plan",
          version: 1,
        },
      }),
    );
    const view = renderPanel({
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
      latestArtifact: null,
      stageSlug: "plan",
    });

    expect(await screen.findByText("Planned")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: false,
        latestArtifact: null,
        loadLatest: false,
        sessionId: SESSION_ID,
        stageSlug: "land",
      }),
    );
    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: false,
        latestArtifact: null,
        loadLatest: true,
        sessionId: SESSION_ID,
        stageSlug: "plan",
      }),
    );

    expect(await screen.findByText("Planned")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("keeps raw Markdown available when formatted rendering fails", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      response({ error: "Formatting unavailable" }, 500),
    );
    renderPanel({ initialFormattedArtifact: null, initialFormattedArtifactKey: null });

    expect((await screen.findByRole("alert")).textContent).toContain("Formatting unavailable");
    fireEvent.click(screen.getByRole("tab", { name: "raw" }));
    expect(screen.getByText("# Latest")).toBeTruthy();
  });
});
