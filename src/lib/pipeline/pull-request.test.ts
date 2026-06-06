import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { openSessionPullRequest } from "./pull-request";

interface UpsertCall {
  row: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

function buildAdminMock(opts: { upsertError?: { message: string } } = {}) {
  const upserts: UpsertCall[] = [];
  return {
    admin: {
      from: (name: string) => {
        if (name !== "session_pull_requests") {
          throw new Error(`Unexpected table: ${name}`);
        }
        return {
          upsert: async (
            row: Record<string, unknown>,
            options: Record<string, unknown> | undefined,
          ) => {
            upserts.push({ row, options });
            return { error: opts.upsertError ?? null };
          },
        };
      },
    },
    upserts,
  };
}

function makeOctokitWithSequence(responses: Array<unknown | Error>) {
  const calls: Array<{ route: string; params: Record<string, unknown> | undefined }> = [];
  const request = vi.fn(async (route: string, params: Record<string, unknown> | undefined) => {
    calls.push({ route, params });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  });
  return { calls, request };
}

type GithubAppFactory = NonNullable<
  Parameters<typeof openSessionPullRequest>[0]["githubAppFactory"]
>;

function makeAppFactory(octokit: { request: unknown }): GithubAppFactory {
  return () =>
    ({
      getInstallationOctokit: vi.fn().mockResolvedValue(octokit),
    }) as unknown as ReturnType<GithubAppFactory>;
}

/** A 422 GitHub error shaped like octokit's RequestError (detail in `errors`). */
function github422(detailMessage: string): Error {
  return Object.assign(new Error("Validation Failed"), {
    status: 422,
    errors: [{ message: detailMessage }],
  });
}

/** Script the sandbox commit-ahead probe (`git merge-base --is-ancestor`). */
function scriptCommitsAhead(sandbox: FakeSandbox, verdict: "NONE" | "AHEAD" | "UNKNOWN") {
  sandbox.scriptExec(
    (call) => call.cmd === "bash" && call.args.join(" ").includes("merge-base"),
    [{ stream: "stdout", data: `${verdict}\n` }],
  );
}

function scriptPush(sandbox: FakeSandbox, opts: { fail?: boolean } = {}) {
  sandbox.scriptExec(
    (call) => call.cmd === "bash" && call.args.join(" ").includes("push --force"),
    opts.fail ? [{ stream: "stderr", data: "remote: Permission denied\n" }] : [],
    opts.fail ? { exitCode: 1 } : {},
  );
}

function scriptBranchDelete(sandbox: FakeSandbox) {
  sandbox.scriptExec((call) => call.cmd === "bash" && call.args.join(" ").includes("--delete"), []);
}

const openPr = {
  draft: false,
  html_url: "https://github.com/acme/app/pull/42",
  merged_at: null,
  number: 42,
  state: "open" as const,
};

const baseInput = {
  baseBranch: "main",
  body: "spec body",
  branch: "wallie/product-sess-1",
  installationId: 123,
  repoFullName: "acme/app",
  repoId: "repo-1",
  sessionId: "sess-1",
  title: "Product: Add SSO",
  workspaceId: "ws-1",
} as const;

describe("openSessionPullRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("records the PR the stage agent already opened, without touching the sandbox", async () => {
    const sandbox = new FakeSandbox();
    // pulls.list (find existing) returns the agent's PR.
    const octokit = makeOctokitWithSequence([[openPr]]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({
      kind: "success",
      isDraft: false,
      prNumber: 42,
      prState: "open",
      prUrl: "https://github.com/acme/app/pull/42",
    });
    // No create, no git work — GitHub already had the PR.
    expect(octokit.calls.map((c) => c.route)).toEqual(["GET /repos/{owner}/{repo}/pulls"]);
    expect(octokit.calls[0]!.params).toMatchObject({
      head: "acme:wallie/product-sess-1",
      owner: "acme",
      repo: "app",
      state: "all",
    });
    expect(sandbox.calls).toHaveLength(0);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.row).toEqual({
      branch_name: "wallie/product-sess-1",
      github_repository_id: "repo-1",
      is_draft: false,
      pull_request_number: 42,
      pull_request_state: "open",
      pull_request_url: "https://github.com/acme/app/pull/42",
      session_id: "sess-1",
      workspace_id: "ws-1",
    });
    expect(upserts[0]!.options).toEqual({ onConflict: "workspace_id,branch_name" });
  });

  it("prefers an open PR over a stale closed one for the same branch", async () => {
    const sandbox = new FakeSandbox();
    const closed = { ...openPr, number: 40, state: "closed" as const, merged_at: null };
    const octokit = makeOctokitWithSequence([[closed, openPr]]);
    const { admin, upserts } = buildAdminMock();

    await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(upserts[0]!.row.pull_request_number).toBe(42);
    expect(upserts[0]!.row.pull_request_state).toBe("open");
  });

  it("pushes and opens a PR when none exists and the branch is ahead of base", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([
      [], // no existing PR
      openPr, // create succeeds
    ]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("success");
    expect(octokit.calls.map((c) => c.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/pulls",
    ]);
    expect(octokit.calls[1]!.params).toEqual({
      base: "main",
      body: "spec body",
      head: "wallie/product-sess-1",
      owner: "acme",
      repo: "app",
      title: "Product: Add SSO",
    });
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("push --force"))).toBe(true);
    expect(upserts[0]!.row.pull_request_number).toBe(42);
  });

  it("returns no_commits without pushing when no PR exists and the branch is not ahead", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "NONE");
    const octokit = makeOctokitWithSequence([[]]); // no existing PR
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({ kind: "no_commits" });
    // Only the existence check hit GitHub; we never tried to create.
    expect(octokit.calls.map((c) => c.route)).toEqual(["GET /repos/{owner}/{repo}/pulls"]);
    // No branch was pushed, so nothing to clean up.
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("push"))).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("recovers via pulls.list when create races and returns 422 already_exists", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([
      [], // initial lookup: none
      github422("A pull request already exists for acme:wallie/product-sess-1"),
      [{ ...openPr, number: 41, draft: true }], // recovery lookup
    ]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("success");
    expect(octokit.calls.map((c) => c.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/pulls",
    ]);
    expect(upserts[0]!.row.pull_request_number).toBe(41);
    expect(upserts[0]!.row.is_draft).toBe(true);
  });

  it("returns no_commits and deletes the pushed branch when GitHub reports no commits between", async () => {
    const sandbox = new FakeSandbox();
    // commit probe can't decide (shallow boundary) → fall through to GitHub.
    scriptCommitsAhead(sandbox, "UNKNOWN");
    scriptPush(sandbox);
    scriptBranchDelete(sandbox);
    const octokit = makeOctokitWithSequence([
      [], // no existing PR
      github422("No commits between main and wallie/product-sess-1"),
    ]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({ kind: "no_commits" });
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("--delete"))).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it("returns push_failed without calling create when the push fails", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox, { fail: true });
    const octokit = makeOctokitWithSequence([[]]); // no existing PR
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("push_failed");
    // Only the lookup hit GitHub; we never attempted to create the PR.
    expect(octokit.calls.map((c) => c.route)).toEqual(["GET /repos/{owner}/{repo}/pulls"]);
    expect(upserts).toHaveLength(0);
  });

  it("marks the PR state as merged when GitHub reports a merged_at timestamp", async () => {
    const sandbox = new FakeSandbox();
    const octokit = makeOctokitWithSequence([
      [
        {
          draft: false,
          html_url: "https://github.com/acme/app/pull/40",
          merged_at: "2026-05-01T00:00:00Z",
          number: 40,
          state: "closed",
        },
      ],
    ]);
    const { admin, upserts } = buildAdminMock();

    await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(upserts[0]!.row.pull_request_state).toBe("merged");
  });

  it("returns pr_failed when the upsert fails", async () => {
    const sandbox = new FakeSandbox();
    const octokit = makeOctokitWithSequence([[openPr]]);
    const { admin, upserts } = buildAdminMock({ upsertError: { message: "db down" } });

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({ kind: "pr_failed", reason: "db down" });
    expect(upserts).toHaveLength(1);
  });

  it("returns pr_failed for an invalid repo full_name", async () => {
    const sandbox = new FakeSandbox();
    const octokit = makeOctokitWithSequence([]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      repoFullName: "no-slash",
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("pr_failed");
    expect(octokit.calls).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });
});
