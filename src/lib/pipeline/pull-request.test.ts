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

function scriptHappyPathSandbox(sandbox: FakeSandbox) {
  // git rev-list base..HEAD --count → "1\n" (one commit ahead).
  sandbox.scriptExec(
    (call) => call.cmd === "bash" && call.args.join(" ").includes("rev-list"),
    [{ stream: "stdout", data: "1\n" }],
  );
  // git push --force origin <branch> → exit 0.
  sandbox.scriptExec((call) => call.cmd === "bash" && call.args.join(" ").includes("git push"), []);
}

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

  it("returns no_commits when the working branch is even with base", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.cmd === "bash" && call.args.join(" ").includes("rev-list"),
      [{ stream: "stdout", data: "0\n" }],
    );
    const octokit = makeOctokitWithSequence([]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome).toEqual({ kind: "no_commits" });
    expect(octokit.calls).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it("pushes, opens the PR, and upserts the session_pull_requests row", async () => {
    const sandbox = new FakeSandbox();
    scriptHappyPathSandbox(sandbox);
    const octokit = makeOctokitWithSequence([
      {
        draft: false,
        html_url: "https://github.com/acme/app/pull/42",
        merged_at: null,
        number: 42,
        state: "open",
      },
    ]);
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
    expect(octokit.calls).toEqual([
      {
        route: "POST /repos/{owner}/{repo}/pulls",
        params: {
          base: "main",
          body: "spec body",
          head: "wallie/product-sess-1",
          owner: "acme",
          repo: "app",
          title: "Product: Add SSO",
        },
      },
    ]);
    expect(upserts).toHaveLength(1);
    const { row, options } = upserts[0]!;
    expect(row).toEqual({
      branch_name: "wallie/product-sess-1",
      github_repository_id: "repo-1",
      is_draft: false,
      pull_request_number: 42,
      pull_request_state: "open",
      pull_request_url: "https://github.com/acme/app/pull/42",
      session_id: "sess-1",
      workspace_id: "ws-1",
    });
    expect(options).toEqual({ onConflict: "workspace_id,branch_name" });
  });

  it("recovers an existing PR via pulls.list when pulls.create returns 422 already_exists", async () => {
    const sandbox = new FakeSandbox();
    scriptHappyPathSandbox(sandbox);
    const alreadyExists = Object.assign(new Error("A pull request already exists for the branch"), {
      status: 422,
    });
    const octokit = makeOctokitWithSequence([
      alreadyExists,
      [
        {
          draft: true,
          html_url: "https://github.com/acme/app/pull/41",
          merged_at: null,
          number: 41,
          state: "open",
        },
      ],
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
      "POST /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/pulls",
    ]);
    expect(upserts[0]!.row.pull_request_number).toBe(41);
    expect(upserts[0]!.row.is_draft).toBe(true);
  });

  it("returns push_failed without calling Octokit when git push fails", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.cmd === "bash" && call.args.join(" ").includes("rev-list"),
      [{ stream: "stdout", data: "1\n" }],
    );
    sandbox.scriptExec(
      (call) => call.cmd === "bash" && call.args.join(" ").includes("git push"),
      [{ stream: "stderr", data: "remote: Permission denied\n" }],
      { exitCode: 1 },
    );
    const octokit = makeOctokitWithSequence([]);
    const { admin, upserts } = buildAdminMock();

    const outcome = await openSessionPullRequest({
      ...baseInput,
      admin: admin as never,
      githubAppFactory: makeAppFactory(octokit),
      sandbox,
    });

    expect(outcome.kind).toBe("push_failed");
    expect(octokit.calls).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it("marks the PR state as merged when GitHub reports a merged_at timestamp", async () => {
    const sandbox = new FakeSandbox();
    scriptHappyPathSandbox(sandbox);
    const octokit = makeOctokitWithSequence([
      {
        draft: false,
        html_url: "https://github.com/acme/app/pull/40",
        merged_at: "2026-05-01T00:00:00Z",
        number: 40,
        state: "closed",
      },
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
});
