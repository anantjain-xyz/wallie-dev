// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import type { SessionArtifactSummary } from "@/features/sessions/types";

const mockedNavigation = vi.hoisted(() => ({
  pathname: "/w/demo/sessions/1",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

const mockedToast = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockedNavigation.pathname,
  useRouter: () => ({ replace: mockedNavigation.replace }),
  useSearchParams: () => mockedNavigation.searchParams,
}));

vi.mock("@/components/ui/toast", () => ({
  useOptionalToast: () => ({
    dismissToast: vi.fn(),
    pushToast: mockedToast.pushToast,
  }),
}));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const latestArtifact: SessionArtifactSummary = {
  createdAt: "2026-06-07T11:00:00.000Z",
  payload: "# Latest",
  stageSlug: "build",
  version: 2,
};

function metadataRow(
  overrides: Partial<{
    attempt: number;
    authorLabel: string;
    changesRequested: boolean;
    createdAt: string;
    stageSlug: string;
    version: number;
  }> = {},
) {
  const version = overrides.version ?? 1;
  return {
    attempt: overrides.attempt ?? version,
    authorLabel: overrides.authorLabel ?? "Claude Code",
    changesRequested: overrides.changesRequested ?? false,
    createdAt: overrides.createdAt ?? "2026-06-07T10:00:00.000Z",
    stageSlug: overrides.stageSlug ?? "build",
    version,
  };
}

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
    mockedNavigation.searchParams = new URLSearchParams();
    mockedNavigation.replace.mockReset();
    mockedToast.pushToast.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the server-formatted latest artifact without requesting history", async () => {
    renderPanel();

    expect(screen.getByText("Latest formatted")).toBeTruthy();
    expect(screen.queryByText("# Latest")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 3, name: /build artifact · version 2/i }),
    ).toBeTruthy();
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });

  it("loads metadata once on demand and does not mount Markdown trees in Versions", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      response({
        artifacts: [
          metadataRow({
            authorLabel: "Claude Code (opus)",
            createdAt: latestArtifact.createdAt,
            version: 2,
          }),
          metadataRow({ changesRequested: true, version: 1 }),
        ],
      }),
    );

    fireEvent.click(renderPanel().getByRole("tab", { name: "Versions" }));
    expect(await screen.findByRole("button", { name: /Version 1/i })).toBeTruthy();
    expect(screen.getByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Claude Code (opus)")).toBeTruthy();
    expect(screen.queryByText("Latest formatted")).toBeNull();
    expect(screen.queryByText("# Latest")).toBeNull();
    expect(document.querySelector(".artifact-content")).toBeNull();
    expect(document.querySelector("[dangerouslySetInnerHTML]")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("version=");
  });

  it("selecting a version updates the URL, heading, and Rendered body only", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
            metadataRow({ version: 1 }),
          ],
        }),
      )
      .mockImplementationOnce(() =>
        response({
          artifact: {
            createdAt: "2026-06-07T10:00:00.000Z",
            payload: "# Earlier",
            sanitizedHtml:
              '<div class="artifact-content"><h1 class="artifact-heading-1">Earlier</h1></div>',
            stageSlug: "build",
            version: 1,
          },
        }),
      );

    fireEvent.click(renderPanel().getByRole("tab", { name: "Versions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Version 1/i }));

    expect(mockedNavigation.replace).toHaveBeenCalledWith(
      "/w/demo/sessions/1?artifactVersion=1&artifactStage=build",
      {
        scroll: false,
      },
    );
    expect(screen.getByRole("tab", { name: "Rendered" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByText("Earlier")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: /build artifact · version 1$/i }),
    ).toBeTruthy();
    expect(
      document.querySelectorAll(".artifact-content, .artifact-heading-1").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Latest formatted")).toBeNull();
  });

  it("supports keyboard tab selection plus failure, retry, and empty states", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() => response({ error: "History unavailable" }, 500))
      .mockImplementationOnce(() => response({ artifacts: [] }));

    renderPanel();
    const artifactTab = screen.getByRole("tab", { name: "Rendered" });
    artifactTab.focus();
    fireEvent.keyDown(artifactTab, { key: "End" });

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
            metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
            metadataRow({ version: 1 }),
          ],
        }),
      )
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            metadataRow({
              authorLabel: "Codex (gpt-5)",
              createdAt: "2026-06-07T12:00:00.000Z",
              version: 3,
            }),
            metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
            metadataRow({ version: 1 }),
          ],
        }),
      );
    const view = renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: /Version 1/i });
    fireEvent.click(screen.getByRole("tab", { name: "Rendered" }));

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
    expect(await screen.findByRole("button", { name: /Version 3/i })).toBeTruthy();
    // Invalidate synthesized "Agent" metadata and refetch authoritative author labels.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Codex (gpt-5)")).toBeTruthy();
  });

  it("delays authoritative metadata refetch until drafting ends", async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
            metadataRow({ version: 1 }),
          ],
        }),
      )
      .mockImplementationOnce(() =>
        response({
          artifacts: [
            metadataRow({
              authorLabel: "Codex (gpt-5)",
              createdAt: "2026-06-07T12:00:00.000Z",
              version: 3,
            }),
            metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
            metadataRow({ version: 1 }),
          ],
        }),
      );

    const view = renderPanel({ isDrafting: true });
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: /Version 1/i });
    fireEvent.click(screen.getByRole("tab", { name: "Rendered" }));

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: true,
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

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByRole("button", { name: /Version 3/i })).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

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

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Codex (gpt-5)")).toBeTruthy();
  });

  it("marks changes requested when rejectionCount increases", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      response({
        artifacts: [
          metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
          metadataRow({ version: 1 }),
        ],
      }),
    );

    const view = renderPanel({ rejectionCount: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: /Version 2/i });
    expect(screen.queryByText("Changes requested")).toBeNull();

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Latest formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
        isDrafting: false,
        latestArtifact,
        loadLatest: true,
        rejectionCount: 1,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    expect(await screen.findByText("Changes requested")).toBeTruthy();
    // No immediate metadata refetch — rejection_count can precede feedback insert.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("clears the optimistic changes-requested marker when rejectionCount rolls back", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      response({
        artifacts: [
          metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
          metadataRow({ version: 1 }),
        ],
      }),
    );

    const view = renderPanel({ rejectionCount: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: /Version 2/i });

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Latest formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
        isDrafting: false,
        latestArtifact,
        loadLatest: true,
        rejectionCount: 1,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );
    expect(await screen.findByText("Changes requested")).toBeTruthy();

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Latest formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
        isDrafting: false,
        latestArtifact,
        loadLatest: true,
        rejectionCount: 0,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    await waitFor(() => expect(screen.queryByText("Changes requested")).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores rejectionCount bumps when the prop is omitted (prior-stage panels)", async () => {
    vi.mocked(fetch).mockImplementationOnce(() =>
      response({
        artifacts: [
          metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
          metadataRow({ version: 1 }),
        ],
      }),
    );

    const view = renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    await screen.findByRole("button", { name: /Version 2/i });

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Latest formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
        isDrafting: false,
        latestArtifact,
        loadLatest: true,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    // Rerender without rejectionCount still must not invent a marker.
    expect(screen.queryByText("Changes requested")).toBeNull();
  });

  it("notifies when a historical version is selected", async () => {
    const onViewingHistoricalChange = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("version=1")) {
        return response({
          artifact: {
            createdAt: "2026-06-07T10:00:00.000Z",
            payload: "# Earlier",
            sanitizedHtml: "<h1>Earlier</h1>",
            stageSlug: "build",
            version: 1,
          },
        });
      }
      return response({
        artifacts: [
          metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
          metadataRow({ version: 1 }),
        ],
      });
    });

    fireEvent.click(
      renderPanel({ onViewingHistoricalChange }).getByRole("tab", { name: "Versions" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Version 1/i }));

    await waitFor(() => expect(onViewingHistoricalChange).toHaveBeenCalledWith(true));
  });

  it("keeps artifactStage when selecting Latest on a prior stage", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      response({
        artifacts: [
          metadataRow({ createdAt: latestArtifact.createdAt, version: 2 }),
          metadataRow({ version: 1 }),
        ],
      }),
    );

    fireEvent.click(
      renderPanel({ persistStageInUrl: true }).getByRole("tab", { name: "Versions" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Version 2.*Latest/i }));

    expect(mockedNavigation.replace).toHaveBeenCalledWith(
      "/w/demo/sessions/1?artifactStage=build",
      { scroll: false },
    );
  });

  it("writes artifactStage when the timeline selects a prior stage", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      response({
        artifacts: [metadataRow({ createdAt: latestArtifact.createdAt, version: 2 })],
      }),
    );
    const view = renderPanel({ persistStageInUrl: false, stageSlug: "land" });

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "No artifact recorded for this stage.",
        initialFormattedArtifact: createElement("div", null, "Latest formatted"),
        initialFormattedArtifactKey: `${SESSION_ID}:build:2`,
        isDrafting: false,
        latestArtifact,
        loadLatest: true,
        persistStageInUrl: true,
        sessionId: SESSION_ID,
        stageSlug: "build",
      }),
    );

    await waitFor(() =>
      expect(mockedNavigation.replace).toHaveBeenCalledWith(
        "/w/demo/sessions/1?artifactStage=build",
        { scroll: false },
      ),
    );
  });

  it("clears artifactVersion and artifactStage from the URL when the selected stage changes", async () => {
    mockedNavigation.searchParams = new URLSearchParams("artifactVersion=1&artifactStage=build");
    vi.mocked(fetch).mockImplementation(() =>
      response({
        artifact: {
          createdAt: "2026-06-07T10:00:00.000Z",
          payload: "# Earlier",
          sanitizedHtml: "<h1>Earlier</h1>",
          stageSlug: "build",
          version: 1,
        },
      }),
    );
    const view = renderPanel();

    view.rerender(
      createElement(ArtifactPanel, {
        emptyText: "This stage has not started yet.",
        initialFormattedArtifact: null,
        initialFormattedArtifactKey: null,
        isDrafting: false,
        latestArtifact: null,
        loadLatest: false,
        sessionId: SESSION_ID,
        stageSlug: "land",
      }),
    );

    await waitFor(() =>
      expect(mockedNavigation.replace).toHaveBeenCalledWith("/w/demo/sessions/1", {
        scroll: false,
      }),
    );
    expect(screen.getByRole("heading", { level: 3, name: /^land artifact$/i })).toBeTruthy();
  });

  it("keeps latest body loading independent from a selected-version fetch", async () => {
    let resolveLatest: ((value: Response) => void) | undefined;
    const latestPromise = new Promise<Response>((resolve) => {
      resolveLatest = resolve;
    });

    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("latest=true")) return latestPromise;
      if (/[?&]version=1(?:&|$)/.test(url)) {
        return response({
          artifact: {
            createdAt: "2026-06-07T10:00:00.000Z",
            payload: "# Earlier",
            sanitizedHtml: '<div class="artifact-content"><h1>Earlier</h1></div>',
            stageSlug: "plan",
            version: 1,
          },
        });
      }
      return response({
        artifacts: [metadataRow({ version: 2 }), metadataRow({ version: 1 })],
      });
    });

    renderPanel({
      initialFormattedArtifact: null,
      initialFormattedArtifactKey: null,
      latestArtifact: null,
      stageSlug: "plan",
    });

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("latest=true")),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Version 1/i }));
    expect(await screen.findByText("Earlier")).toBeTruthy();

    resolveLatest?.(
      new Response(
        JSON.stringify({
          artifact: {
            createdAt: "2026-06-07T11:00:00.000Z",
            payload: "# Plan latest",
            sanitizedHtml: '<div class="artifact-content"><h1>Plan latest</h1></div>',
            stageSlug: "plan",
            version: 2,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByRole("button", { name: /Version 2.*Latest/i })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByText("# Latest")).toBeTruthy();
  });

  it("copies Markdown through the shared toast feedback system", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Latest"));
    expect(mockedToast.pushToast).toHaveBeenCalledWith({
      priority: "polite",
      title: "Markdown copied.",
      tone: "success",
    });
  });

  it("reports copy failure through the shared toast feedback system", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    await waitFor(() =>
      expect(mockedToast.pushToast).toHaveBeenCalledWith({
        priority: "assertive",
        title: "Could not copy Markdown.",
        tone: "danger",
      }),
    );
  });
});
