import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { openSessionPullRequest, resumeSessionPullRequestPublication } from "./pull-request";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn(() => "linear-api-key"),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

interface UpsertCall {
  row: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

function buildAdminMock(
  opts: {
    deleteError?: { message: string } | null;
    linearSecret?: { encrypted_value: string } | null;
    linearSecretError?: { message: string } | null;
    upsertError?: { message: string };
  } = {},
) {
  const deletes: Array<Record<string, unknown>> = [];
  const upserts: UpsertCall[] = [];
  return {
    admin: {
      from: (name: string) => {
        if (name === "workspace_secrets") {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: opts.linearSecret ?? null,
              error: opts.linearSecretError ?? null,
            }),
            select: () => chain,
          };
          return chain;
        }
        if (name === "session_pull_requests") {
          return {
            delete: () => {
              const filters: Record<string, unknown> = {};
              const chain = {
                eq: (column: string, value: unknown) => {
                  filters[column] = value;
                  return chain;
                },
                then: (resolve: (value: { error: { message: string } | null }) => void) => {
                  deletes.push(filters);
                  resolve({ error: opts.deleteError ?? null });
                },
              };
              return chain;
            },
            upsert: async (
              row: Record<string, unknown>,
              options: Record<string, unknown> | undefined,
            ) => {
              upserts.push({ row, options });
              return { error: opts.upsertError ?? null };
            },
          };
        }
        throw new Error(`Unexpected table: ${name}`);
      },
    },
    deletes,
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
  linearIssueId: null,
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

  it("refreshes the remote branch before reusing the PR the agent already opened", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    // pulls.list (find existing) returns Wallie's PR.
    const octokit = makeOctokitWithSequence([[openPr], openPr]);
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
    // Reuses the existing PR (no create), pushes this run's commits, and
    // refreshes the PR body from the latest Build artifact.
    expect(octokit.calls.map((c) => c.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
    expect(octokit.calls[0]!.params).toMatchObject({
      head: "acme:wallie/product-sess-1",
      owner: "acme",
      repo: "app",
      state: "all",
    });
    expect(octokit.calls[1]!.params).toEqual({
      body: "spec body",
      owner: "acme",
      pull_number: 42,
      repo: "app",
      title: "Product: Add SSO",
    });
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("push --force"))).toBe(true);
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

  it("opens a replacement when a reused PR closes after the retry push", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const closedDuringRefresh = { ...openPr, merged_at: null, state: "closed" as const };
    const replacement = {
      ...openPr,
      html_url: "https://github.com/acme/app/pull/43",
      number: 43,
    };
    const octokit = makeOctokitWithSequence([[openPr], closedDuringRefresh, replacement]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toMatchObject({ kind: "success", prNumber: 43, prState: "open" });
    expect(octokit.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      "POST /repos/{owner}/{repo}/pulls",
    ]);
    expect(upserts[0]?.row.pull_request_number).toBe(43);
  });

  it("does not reuse rejected PR commits when a retry produces no commits", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "NONE");
    const octokit = makeOctokitWithSequence([[openPr], { ...openPr, state: "closed" }]);
    const { admin, deletes, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("no_commits");
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("push"))).toBe(false);
    expect(octokit.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
    expect(octokit.calls[1]?.params).toMatchObject({ pull_number: 42, state: "closed" });
    expect(deletes).toEqual([
      {
        branch_name: "wallie/product-sess-1",
        pull_request_number: 42,
        session_id: "sess-1",
        workspace_id: "ws-1",
      },
    ]);
    expect(upserts).toHaveLength(0);
  });

  it("keeps a closed rejected PR detached on a later no-commit retry", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "NONE");
    const closed = { ...openPr, merged_at: null, state: "closed" as const };
    const octokit = makeOctokitWithSequence([[closed], closed]);
    const { admin, deletes, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("no_commits");
    expect(deletes).toHaveLength(1);
    expect(upserts).toHaveLength(0);
  });

  it("retries only publication when refreshing an existing PR fails after push", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([[openPr], new Error("GitHub PATCH unavailable")]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({
      kind: "publication_failed",
      pullRequestNumber: 42,
      reason: "GitHub PATCH unavailable",
    });
    expect(sandbox.calls.some((call) => call.args.join(" ").includes("push --force"))).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it("prefers an open PR over a stale closed one for the same branch", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const closed = { ...openPr, number: 40, state: "closed" as const, merged_at: null };
    const octokit = makeOctokitWithSequence([[closed, openPr], openPr]);
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

  it("opens a fresh PR instead of reusing a closed, unmerged one for new work", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const closed = { ...openPr, number: 40, state: "closed" as const, merged_at: null };
    const reopened = { ...openPr, number: 43 };
    const octokit = makeOctokitWithSequence([
      [closed], // only PR for the branch is closed + unmerged
      reopened, // create a new one
    ]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("success");
    // Did not reuse the closed PR — pushed and created a new reviewable one.
    expect(octokit.calls.map((c) => c.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/pulls",
    ]);
    expect(sandbox.calls.some((c) => c.args.join(" ").includes("push --force"))).toBe(true);
    expect(upserts[0]!.row.pull_request_number).toBe(43);
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

  it("normalizes and bounds generated pull request titles", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([[], openPr]);
    const { admin } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
      title: `Build:\n${"x".repeat(300)}`,
    });

    expect(outcome.kind).toBe("success");
    const title = octokit.calls[1]?.params?.title;
    expect(title).toBeTypeOf("string");
    expect(Array.from(title as string)).toHaveLength(256);
    expect(title).not.toContain("\n");
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
    const recoveredPr = { ...openPr, number: 41, draft: true };
    const octokit = makeOctokitWithSequence([
      [], // initial lookup: none
      github422("A pull request already exists for acme:wallie/product-sess-1"),
      [recoveredPr], // recovery lookup
      recoveredPr, // refresh result
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
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
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
    scriptCommitsAhead(sandbox, "NONE"); // merged PR: commits already landed
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

  it("returns a publication-only retry when the upsert fails after GitHub succeeds", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([[openPr], openPr]);
    const { admin, upserts } = buildAdminMock({ upsertError: { message: "db down" } });

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({
      kind: "publication_failed",
      pullRequestNumber: 42,
      reason: "db down",
    });
    expect(upserts).toHaveLength(1);
  });

  it("idempotently attaches a published PR to its Linear issue", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([[], openPr]);
    const { admin } = buildAdminMock({
      linearSecret: { encrypted_value: "encrypted-linear-key" },
    });
    const linearAttachment = vi.fn().mockResolvedValue(undefined);

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      linearAttachment,
      linearIssueId: "TEAM-1",
      sandbox,
    });

    expect(outcome.kind).toBe("success");
    expect(mocked.decryptSecretValue).toHaveBeenCalledWith("encrypted-linear-key");
    expect(linearAttachment).toHaveBeenCalledWith("linear-api-key", "TEAM-1", {
      pullRequestNumber: 42,
      title: "Product: Add SSO",
      url: "https://github.com/acme/app/pull/42",
    });
  });

  it("returns a retryable publication failure when Linear attachment fails", async () => {
    const sandbox = new FakeSandbox();
    scriptCommitsAhead(sandbox, "AHEAD");
    scriptPush(sandbox);
    const octokit = makeOctokitWithSequence([[], openPr]);
    const { admin } = buildAdminMock({
      linearSecret: { encrypted_value: "encrypted-linear-key" },
    });

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      linearAttachment: vi.fn().mockRejectedValue(new Error("Linear unavailable")),
      linearIssueId: "TEAM-1",
      sandbox,
    });

    expect(outcome).toEqual({
      kind: "publication_failed",
      pullRequestNumber: 42,
      reason: "Failed to attach pull request to Linear: Linear unavailable",
    });
  });

  it("resumes durable publication without a sandbox or branch push", async () => {
    const octokit = makeOctokitWithSequence([
      openPr,
      openPr, // refresh title/body
    ]);
    const { admin, upserts } = buildAdminMock({
      linearSecret: { encrypted_value: "encrypted-linear-key" },
    });
    const linearAttachment = vi.fn().mockResolvedValue(undefined);

    const outcome = await resumeSessionPullRequestPublication({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      linearAttachment,
      linearIssueId: "TEAM-1",
      pullRequestNumber: 42,
    });

    expect(outcome.kind).toBe("success");
    expect(octokit.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
    expect(upserts).toHaveLength(1);
    expect(linearAttachment).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh PR when the checkpointed PR was closed without merging", async () => {
    const closedPr = { ...openPr, merged_at: null, state: "closed" as const };
    const replacementPr = {
      ...openPr,
      html_url: "https://github.com/acme/app/pull/43",
      number: 43,
    };
    const octokit = makeOctokitWithSequence([closedPr, replacementPr]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await resumeSessionPullRequestPublication({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      pullRequestNumber: 42,
    });

    expect(outcome).toMatchObject({ kind: "success", prNumber: 43 });
    expect(octokit.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "POST /repos/{owner}/{repo}/pulls",
    ]);
    expect(octokit.calls[1]?.params).toMatchObject({
      base: "main",
      body: "spec body",
      head: "wallie/product-sess-1",
      title: "Product: Add SSO",
    });
    expect(upserts[0]?.row).toMatchObject({
      pull_request_number: 43,
      pull_request_state: "open",
      pull_request_url: "https://github.com/acme/app/pull/43",
    });
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
