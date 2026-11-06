import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPrDiff, PrDiffApiError } from "./pr-diff";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: headSha, repo: { id: 123, full_name: "acme/app" } },
    base: { sha: baseSha, repo: { id: 123, full_name: "acme/app" } },
    ...overrides,
  };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    filename: "src/example.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: "@@ -1,1 +1,2 @@\n-old\n+new\n+another",
    blob_url: "https://github.com/acme/app/blob/head/src/example.ts",
    ...overrides,
  };
}

function response(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fetchSequence(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const value of responses) fetchMock.mockResolvedValueOnce(value);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const input = {
  token: "ghs_test",
  repositoryFullName: "acme/app",
  repositoryNumericId: 123,
  prNumber: 42,
  expectedUrl: "https://github.com/acme/app/pull/42",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical pull request diff", () => {
  it("reads the pinned PR and bounds its files and patch text", async () => {
    const longPatch = [
      "@@ -1 +1 @@",
      ...Array.from({ length: 500 }, (_, index) => `+${index}`),
    ].join("\n");
    const fetchMock = fetchSequence(
      response(pr()),
      response([file({ patch: longPatch }), file({ filename: "README.md", patch: undefined })], {
        link: '<https://api.github.com/repos/acme/app/pulls/42/files?page=2>; rel="next"',
      }),
      response(pr()),
    );
    const diff = await loadPrDiff(input);
    expect(diff).toMatchObject({
      repositoryFullName: "acme/app",
      prNumber: 42,
      headSha,
      baseSha,
      additions: 4,
      deletions: 2,
      hasMore: true,
      truncated: true,
    });
    expect(diff.files[0]?.patchTruncated).toBe(true);
    expect(diff.files[0]?.patch?.split("\n")).toHaveLength(400);
    expect(diff.files[1]?.patchUnavailable).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/app/pulls/42");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/app/pulls/42/files?per_page=100&page=1",
    );
  });

  it("rejects a PR whose repository identity does not match the pinned repository", async () => {
    fetchSequence(
      response(pr({ base: { sha: baseSha, repo: { id: 999, full_name: "acme/app" } } })),
    );
    await expect(loadPrDiff(input)).rejects.toMatchObject({
      code: "github_identity_mismatch",
    });
  });

  it("rejects a PR URL that is not the pinned canonical URL", async () => {
    fetchSequence(response(pr({ html_url: "https://github.com/acme/app/pull/43" })));
    await expect(loadPrDiff(input)).rejects.toMatchObject({
      code: "github_identity_mismatch",
    });
  });

  it("rejects a push that lands while the diff is being collected", async () => {
    fetchSequence(
      response(pr()),
      response([file()]),
      response(
        pr({
          head: {
            sha: "c".repeat(40),
            repo: { id: 123, full_name: "acme/app" },
          },
        }),
      ),
    );
    await expect(loadPrDiff(input)).rejects.toMatchObject({
      code: "github_identity_mismatch",
    });
  });

  it("maps provider failures to fixed codes without exposing provider text", async () => {
    fetchSequence(new Response("forbidden", { status: 403 }));
    await expect(loadPrDiff(input)).rejects.toBeInstanceOf(PrDiffApiError);
    fetchSequence(
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    await expect(loadPrDiff(input)).rejects.toMatchObject({ code: "github_rate_limited" });
    fetchSequence(new Response("missing", { status: 404 }));
    await expect(loadPrDiff(input)).rejects.toMatchObject({ code: "github_not_found" });
  });

  it("returns a merged state only when GitHub reports a merge", async () => {
    fetchSequence(
      response(
        pr({
          state: "closed",
          merged_at: "2026-11-06T00:00:00Z",
        }),
      ),
      response([file()]),
      response(
        pr({
          state: "closed",
          merged_at: "2026-11-06T00:00:00Z",
        }),
      ),
    );
    expect((await loadPrDiff(input)).state).toBe("merged");
  });
});
