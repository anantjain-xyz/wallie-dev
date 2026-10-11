import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { SourceDelivery } from "./source-delivery";
import { ensureSourcePullRequest } from "./source-pull-request";

const delivery = {
  repository_full_name: "acme/app",
  branch_name: "wallie/attempt",
  base_branch: "trunk",
  head_sha: "a".repeat(40),
  title: "Build",
  body: "done",
  repository_id: "repository",
  session_id: "session",
  workspace_id: "workspace",
} as SourceDelivery;
const pr = {
  number: 42,
  html_url: "https://github.com/acme/app/pull/42",
  draft: false,
  state: "open",
  merged_at: null,
  updated_at: "2026-10-01T00:00:00Z",
  head: { ref: "wallie/attempt", sha: delivery.head_sha, repo: { full_name: "acme/app" } },
};
function setup(responses: Array<unknown>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  });
  vi.stubGlobal("fetch", fetch);
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ error: null }) }));
  return {
    fetch,
    rpc,
    input: {
      admin: { rpc } as unknown as SupabaseClient<Database>,
      delivery,
      token: "scoped-token",
      signal: new AbortController().signal,
      verifyOwnership: vi.fn().mockResolvedValue(undefined),
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it("creates a PR and persists provider time through the identity guarded metadata RPC", async () => {
  const { input, fetch, rpc } = setup([[], pr]);
  await ensureSourcePullRequest(input);
  expect(fetch.mock.calls[1]).toEqual([
    "https://api.github.com/repos/acme/app/pulls",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ base: "trunk", head: "wallie/attempt", title: "Build", body: "done" }),
    }),
  ]);
  expect(rpc).toHaveBeenCalledWith(
    "record_session_pull_request",
    expect.objectContaining({
      target_repository_id: "repository",
      source_updated_at: pr.updated_at,
      source_pull_request_number: 42,
    }),
  );
});

it("recovers an ambiguous create response by reading the exact head without creating another PR", async () => {
  const { input, fetch, rpc } = setup([[], new Error("response lost"), [pr]]);
  await ensureSourcePullRequest(input);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenCalledOnce();
});

it("reuses an already recorded closed or merged PR after a delivery retry", async () => {
  const { input, fetch, rpc } = setup([
    [{ ...pr, state: "closed", merged_at: "2026-10-02T00:00:00Z" }],
  ]);
  await ensureSourcePullRequest(input);
  expect(fetch).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith(
    "record_session_pull_request",
    expect.objectContaining({ source_pull_request_state: "merged" }),
  );
});

it.each(["closed", "merged"])(
  "opens a fresh PR when the previous %s PR has an older head",
  async (state) => {
    const old = {
      ...pr,
      state: "closed",
      merged_at: state === "merged" ? "2026-10-02T00:00:00Z" : null,
      head: { ...pr.head, sha: "b".repeat(40) },
    };
    const { input, fetch, rpc } = setup([[old], { status: "behind" }, { ...pr, number: 43 }]);
    await ensureSourcePullRequest(input);
    expect(fetch.mock.calls[1][0]).toContain(`/compare/${delivery.head_sha}...${old.head.sha}`);
    expect(fetch.mock.calls[2][1]?.method).toBe("POST");
    expect(rpc).toHaveBeenCalledWith(
      "record_session_pull_request",
      expect.objectContaining({ source_pull_request_number: 43 }),
    );
  },
);

it("reuses a closed PR only when its head is proven to contain the delivered commit", async () => {
  const old = { ...pr, state: "closed", head: { ...pr.head, sha: "b".repeat(40) } };
  const { input, fetch, rpc } = setup([[old], { status: "ahead" }]);
  await ensureSourcePullRequest(input);
  expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  expect(rpc).toHaveBeenCalledWith(
    "record_session_pull_request",
    expect.objectContaining({ source_pull_request_number: 42 }),
  );
});

it("accepts an older merged PR only through a separate base containment proof", async () => {
  const old = {
    ...pr,
    state: "closed",
    merged_at: "2026-10-02T00:00:00Z",
    head: { ...pr.head, sha: "b".repeat(40) },
  };
  const { input, fetch, rpc } = setup([
    [old],
    { status: "behind" },
    new Error("No commits"),
    [old],
    { status: "behind" },
    { status: "identical" },
  ]);
  await ensureSourcePullRequest(input);
  expect(fetch.mock.calls.at(-1)?.[0]).toContain(`/compare/trunk...${delivery.head_sha}`);
  expect(rpc).not.toHaveBeenCalled();
});

it("completes without a PR when the base already contains the delayed source", async () => {
  const { input, fetch, rpc } = setup([[], new Error("No commits"), [], { status: "behind" }]);
  await ensureSourcePullRequest(input);
  expect(fetch.mock.calls.at(-1)?.[0]).toContain(`/compare/trunk...${delivery.head_sha}`);
  expect(rpc).not.toHaveBeenCalled();
});

it("rejects repository identities that could redirect the privileged request", async () => {
  const { input, fetch } = setup([]);
  await expect(
    ensureSourcePullRequest({
      ...input,
      delivery: { ...delivery, repository_full_name: "acme/app/../../other" },
    }),
  ).rejects.toThrow("Invalid source repository");
  expect(fetch).not.toHaveBeenCalled();
});

it("does not create a PR if cancellation wins while the lookup is in flight", async () => {
  const { input, fetch, rpc } = setup([[]]);
  input.verifyOwnership.mockRejectedValueOnce(new Error("canceled"));
  await expect(ensureSourcePullRequest(input)).rejects.toThrow("canceled");
  expect(fetch).toHaveBeenCalledOnce();
  expect(rpc).not.toHaveBeenCalled();
});

it("ignores a fork PR with the same head branch name", async () => {
  const fork = {
    ...pr,
    number: 99,
    head: { ref: delivery.branch_name, repo: { full_name: "acme/fork" } },
  };
  const { input, fetch, rpc } = setup([[fork], pr]);
  await ensureSourcePullRequest(input);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenCalledWith(
    "record_session_pull_request",
    expect.objectContaining({ source_pull_request_number: 42 }),
  );
});
