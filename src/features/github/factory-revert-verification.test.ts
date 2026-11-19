import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { FactoryRevertTarget } from "@/lib/factory-outcomes/revert-contracts";

import { verifyFactoryRevertPullRequest } from "./factory-revert-verification";
import { mintPrVerificationToken } from "./pr-verification-auth";

vi.mock("./pr-verification-auth");

const target = {
  mergeId: "59600000-0000-4000-8000-000000000001",
  observationId: "59600000-0000-4000-8000-000000000002",
  repositoryId: "59600000-0000-4000-8000-000000000003",
  repositoryNumericId: 456,
  repositoryFullName: "scope/project",
  installationId: 123,
  baseBranch: "main",
  pullRequestNumber: 42,
  mergeCommitSha: "a".repeat(40),
  mergedAt: "2026-01-01T00:00:00Z",
} satisfies FactoryRevertTarget;

const provider = {
  number: 43,
  html_url: "https://github.com/scope/project/pull/43",
  state: "closed",
  draft: false,
  merged: true,
  merged_at: "2026-01-02T00:00:00Z",
  merge_commit_sha: "b".repeat(40),
  updated_at: "2026-01-02T00:00:01Z",
  head: { sha: "c".repeat(40), repo: null },
  base: { ref: "main", repo: { id: 456, full_name: "scope/project" } },
};

function setup(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mintPrVerificationToken).mockResolvedValue({
    token: "synthetic-read-token",
    installationPermissions: { pull_requests: "read" },
  });
});

afterEach(() => vi.unstubAllGlobals());

it("observes an exact merged PR using one narrowed credential and an unredirected GET", async () => {
  const fetcher = setup(Response.json(provider));
  expect(
    await verifyFactoryRevertPullRequest({
      target,
      revertPrNumber: 43,
      signal: new AbortController().signal,
    }),
  ).toEqual({
    ok: true,
    proof: {
      repositoryNumericId: 456,
      baseBranch: "main",
      pullRequestNumber: 43,
      mergeCommitSha: provider.merge_commit_sha,
      mergedAt: provider.merged_at,
      updatedAt: provider.updated_at,
    },
  });
  expect(mintPrVerificationToken).toHaveBeenCalledExactlyOnceWith({
    repositoryNumericId: 456,
    installationId: 123,
    signal: expect.any(AbortSignal),
  });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/scope/project/pulls/43",
    expect.objectContaining({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-read-token" }),
    }),
  );
});

it.each([
  { number: 44 },
  { base: { ...provider.base, repo: { ...provider.base.repo, id: 123 } } },
  { base: { ...provider.base, repo: { ...provider.base.repo, full_name: "scope/other" } } },
  { base: { ...provider.base, ref: "staging" } },
  { html_url: "https://elsewhere.example/scope/project/pull/43" },
  { html_url: "https://github.com/scope/project/pull/44" },
  { state: "open" },
  { merged: false },
  { draft: true },
  { merge_commit_sha: "test-merge" },
  { merge_commit_sha: target.mergeCommitSha },
  { merged_at: target.mergedAt },
  { merged_at: "2026-01-03T00:00:00Z" },
])("withholds proof for a wrong or incomplete GitHub observation %o", async (change) => {
  setup(Response.json({ ...provider, ...change }));
  expect(
    await verifyFactoryRevertPullRequest({
      target,
      revertPrNumber: 43,
      signal: new AbortController().signal,
    }),
  ).toEqual({ ok: false, code: "unverified" });
});

it.each([false, true])(
  "rejects a clock-ahead provider update (merged clock ahead: %s)",
  async (both) => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setup(
      Response.json({
        ...provider,
        merged_at: both ? future : provider.merged_at,
        updated_at: future,
      }),
    );
    expect(
      await verifyFactoryRevertPullRequest({
        target,
        revertPrNumber: 43,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: "unverified" });
  },
);

it("does not follow a redirect or surface the provider URL", async () => {
  const fetcher = setup(
    new Response(null, {
      status: 302,
      headers: { Location: "https://elsewhere.example/private" },
    }),
  );
  expect(
    await verifyFactoryRevertPullRequest({
      target,
      revertPrNumber: 43,
      signal: new AbortController().signal,
    }),
  ).toEqual({ ok: false, code: "unavailable" });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("declines the original PR and an aborted request before obtaining access", async () => {
  const fetcher = setup(Response.json(provider));
  const signal = new AbortController().signal;
  expect(await verifyFactoryRevertPullRequest({ target, revertPrNumber: 42, signal })).toEqual({
    ok: false,
    code: "unverified",
  });
  expect(
    await verifyFactoryRevertPullRequest({
      target,
      revertPrNumber: 43,
      signal: AbortSignal.abort(),
    }),
  ).toEqual({ ok: false, code: "unavailable" });
  expect(mintPrVerificationToken).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
