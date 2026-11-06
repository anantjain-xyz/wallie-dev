// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SessionReviewDiff } from "./session-review-diff";

const sessionId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);

function diff(overrides: Record<string, unknown> = {}) {
  return {
    repositoryFullName: "acme/app",
    prNumber: 42,
    url: "https://github.com/acme/app/pull/42",
    headSha: sha,
    baseSha,
    state: "open",
    draft: false,
    files: [
      {
        filename: "src/example.ts",
        previousFilename: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+another",
        patchTruncated: false,
        patchUnavailable: false,
        blobUrl: "https://github.com/acme/app/blob/head/src/example.ts",
      },
    ],
    additions: 2,
    deletions: 1,
    hasMore: false,
    truncated: false,
    limits: { maxFiles: 100, maxPatchLines: 400, maxPatchCharacters: 24000 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDiff(prUrl: string | null = "https://github.com/acme/app/pull/42") {
  return render(
    <SessionReviewDiff
      observedHeadSha={sha}
      observedBaseSha={baseSha}
      prUrl={prUrl}
      sessionId={sessionId}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads the diff lazily and exposes explicit bounded limits", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse({
      diff: diff({
        files: [
          {
            ...diff().files[0],
            patchTruncated: true,
          },
          {
            filename: "assets/logo.png",
            previousFilename: null,
            status: "modified",
            additions: 0,
            deletions: 0,
            changes: 0,
            patch: null,
            patchTruncated: false,
            patchUnavailable: true,
            blobUrl: null,
          },
        ],
        hasMore: true,
        truncated: true,
      }),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderDiff();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
  expect(await screen.findByText(/Only the first 100 changed files/)).toBeTruthy();
  expect(screen.getByText(/binary or too large/)).toBeTruthy();
  expect(screen.getByText(/This file's diff is truncated/)).toBeTruthy();
  expect(screen.getByText(/This diff is intentionally bounded/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Open full diff on GitHub/ })).toHaveAttribute(
    "href",
    "https://github.com/acme/app/pull/42/files",
  );
  expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/${sessionId}/review-evidence/diff`, {
    cache: "no-store",
  });
});

it.each(["head", "base"] as const)(
  "warns about a newer GitHub %s without repeatedly reloading",
  async (changed) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        diff: diff({
          headSha: changed === "head" ? "c".repeat(40) : sha,
          baseSha: changed === "base" ? "c".repeat(40) : baseSha,
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderDiff();
    fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
    expect(await screen.findByText(/Refresh delivery readiness before approving/)).toBeTruthy();
    expect(screen.queryByText(/GitHub now reports/)).toBeNull();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("keeps a diff failure recoverable with a GitHub fallback", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
    .mockResolvedValueOnce(jsonResponse({ diff: diff() }));
  vi.stubGlobal("fetch", fetchMock);
  renderDiff();
  fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Code changes could not be loaded from GitHub",
  );
  expect(screen.getByRole("link", { name: /Open full diff on GitHub/ })).toHaveAttribute(
    "href",
    "https://github.com/acme/app/pull/42/files",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("src/example.ts")).toBeTruthy();
});

it("does not render a diff control before a canonical PR exists", () => {
  renderDiff(null);
  expect(screen.queryByRole("button", { name: "Show code changes" })).toBeNull();
});

it.each(["head", "base"] as const)(
  "reloads an expanded diff when the observed %s changes",
  async (changed) => {
    const nextSha = "c".repeat(40);
    const nextHead = changed === "head" ? nextSha : sha;
    const nextBase = changed === "base" ? nextSha : baseSha;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ diff: diff() }))
      .mockResolvedValueOnce(
        jsonResponse({
          diff: diff({
            headSha: nextHead,
            baseSha: nextBase,
            files: [{ ...diff().files[0], patch: "@@ -1 +1 @@\n-old\n+revised" }],
          }),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const view = renderDiff();
    fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
    expect(await screen.findByText("+another")).toBeTruthy();
    view.rerender(
      <SessionReviewDiff
        observedHeadSha={nextHead}
        observedBaseSha={nextBase}
        prUrl="https://github.com/acme/app/pull/42"
        sessionId={sessionId}
      />,
    );
    expect(await screen.findByText("+revised")).toBeTruthy();
    expect(screen.queryByText("+another")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide code changes" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Refresh delivery readiness before approving/)).toBeNull();
  },
);

it("keeps a closed diff lazy after the observed revision changes", async () => {
  const nextBase = "c".repeat(40);
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ diff: diff({ baseSha: nextBase }) }));
  vi.stubGlobal("fetch", fetchMock);
  const view = renderDiff();
  view.rerender(
    <SessionReviewDiff
      observedHeadSha={sha}
      observedBaseSha={nextBase}
      prUrl="https://github.com/acme/app/pull/42"
      sessionId={sessionId}
    />,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
  expect(await screen.findByText("+another")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("discards an in-flight response from the previous observed revision", async () => {
  const nextBase = "c".repeat(40);
  let resolvePrevious!: (response: Response) => void;
  const previous = new Promise<Response>((resolve) => {
    resolvePrevious = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(previous)
    .mockResolvedValueOnce(
      jsonResponse({
        diff: diff({
          baseSha: nextBase,
          files: [{ ...diff().files[0], patch: "@@ -1 +1 @@\n-old\n+current" }],
        }),
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const view = renderDiff();
  fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  view.rerender(
    <SessionReviewDiff
      observedHeadSha={sha}
      observedBaseSha={nextBase}
      prUrl="https://github.com/acme/app/pull/42"
      sessionId={sessionId}
    />,
  );
  expect(await screen.findByText("+current")).toBeTruthy();
  await act(async () => resolvePrevious(jsonResponse({ diff: diff() })));
  expect(screen.getByText("+current")).toBeTruthy();
  expect(screen.queryByText("+another")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
