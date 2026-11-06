// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return render(<SessionReviewDiff observedHeadSha={sha} prUrl={prUrl} sessionId={sessionId} />);
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

it("warns when GitHub head moved past the last verified observation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        diff: diff({ headSha: "c".repeat(40) }),
      }),
    ),
  );
  renderDiff();
  fireEvent.click(screen.getByRole("button", { name: "Show code changes" }));
  expect(await screen.findByText(/Refresh delivery readiness before approving/)).toBeTruthy();
});

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
