import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";
import { collectPrVerification } from "@/features/github/pr-verification-api";
import { createCanonicalPrApi } from "@/lib/pipeline/canonical-pr-api";
import type { Database } from "@/lib/supabase/database.types";
import {
  resolveSourceDeliveryRepository,
  type SourceDelivery,
} from "@/lib/pipeline/source-delivery";
import { ensureSourcePullRequest } from "@/lib/pipeline/source-pull-request";

vi.mock("@/features/github/sandbox-token", () => ({
  mintSandboxRepositoryToken: async () => "synthetic-repository-token",
}));

afterEach(() => vi.unstubAllGlobals());

it("verifies the repository and creates its PR in workerd with GitHub's required User-Agent", async () => {
  const delivery: SourceDelivery = {
    attempt_count: 1,
    base_branch: "trunk",
    base_sha: "a".repeat(40),
    body: "Done",
    branch_name: "wallie/attempt",
    bundle_base64: null,
    bundle_sha256: null,
    checkpoint_path: null,
    claim_id: null,
    created_at: "2026-11-07T00:00:00Z",
    delivered_at: null,
    delivered_ref: null,
    delivery_attempt_count: 0,
    head_sha: "b".repeat(40),
    installation_id: 456,
    job_id: "job",
    last_error_code: null,
    lease_expires_at: null,
    next_attempt_at: "2026-11-07T00:00:00Z",
    repository_full_name: "example/repo",
    repository_id: "repository",
    run_id: "run",
    session_id: "session",
    status: "pending",
    title: "Build",
    workspace_id: "workspace",
  };
  const githubRequests: Request[] = [];
  const metadataWrites: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "example.supabase.co") {
        if (url.pathname.endsWith("/github_repositories"))
          return Response.json([
            {
              full_name: delivery.repository_full_name,
              github_installation_id: "installation",
              repo_id: 789,
              is_archived: false,
            },
          ]);
        if (url.pathname.endsWith("/github_installations"))
          return Response.json([{ installation_id: delivery.installation_id }]);
        if (url.pathname.endsWith("/rpc/record_session_pull_request")) {
          metadataWrites.push(await request.json());
          return Response.json(null);
        }
      }
      if (url.hostname === "api.github.com") {
        githubRequests.push(request);
        if (!request.headers.get("User-Agent"))
          return new Response("Please make sure your request has a User-Agent header.", {
            status: 403,
          });
        if (url.pathname === "/repos/example/repo")
          return Response.json({ id: 789, full_name: delivery.repository_full_name });
        if (url.pathname === "/repos/example/repo/pulls")
          return Response.json(
            request.method === "GET"
              ? []
              : {
                  number: 42,
                  html_url: "https://github.com/example/repo/pull/42",
                  draft: false,
                  state: "open",
                  merged_at: null,
                  updated_at: "2026-11-07T00:01:00Z",
                  head: {
                    ref: delivery.branch_name,
                    sha: delivery.head_sha,
                    repo: { full_name: delivery.repository_full_name },
                  },
                },
          );
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }),
  );
  const admin = createClient<Database>("https://example.supabase.co", "synthetic-service-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signal = new AbortController().signal;
  const current = await resolveSourceDeliveryRepository(admin, delivery, signal);
  await ensureSourcePullRequest({
    admin,
    delivery: current.delivery,
    token: current.token,
    signal,
    verifyOwnership: async () => undefined,
  });

  expect(githubRequests).toHaveLength(3);
  expect(githubRequests.map((request) => request.headers.get("User-Agent"))).toEqual([
    "Wallie",
    "Wallie",
    "Wallie",
  ]);
  expect(metadataWrites).toEqual([
    expect.objectContaining({ source_pull_request_number: 42, target_session_id: "session" }),
  ]);
});

it("sends GitHub's required User-Agent when worker maintenance verifies a PR", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return new Response(null, { status: request.headers.get("User-Agent") ? 404 : 403 });
    }),
  );
  await expect(
    collectPrVerification({
      token: "synthetic-repository-token",
      repositoryFullName: "example/repo",
      repositoryNumericId: 789,
      prNumber: 42,
      branchName: "wallie/attempt",
      baseBranch: "trunk",
      signal: new AbortController().signal,
      requirements: {
        version: 1,
        deliveryMode: "code",
        requiredChecks: [],
        minimumApprovals: 0,
        requireCodeOwnerReview: false,
        requireResolvedThreads: false,
        requiredEvidence: [],
        freshnessSeconds: 3600,
        requireArtifactApprovalForDelivery: true,
      },
      installationPermissions: {
        contents: "read",
        checks: "read",
        statuses: "read",
        pull_requests: "read",
      },
    }),
  ).rejects.toMatchObject({ code: "github_not_found" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.get("User-Agent")).toBe("Wallie");
});

it("finds, creates, and reads a canonical PR in workerd with GitHub's required User-Agent", async () => {
  const requests: Request[] = [];
  const repository = { id: 789, full_name: "example/repo" };
  const headSha = "b".repeat(40);
  const branch = "wallie/sessions/session/epoch";
  const pr = {
    number: 42,
    html_url: "https://github.com/example/repo/pull/42",
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-11-07T00:01:00Z",
    head: { ref: branch, sha: headSha, repo: repository },
    base: { ref: "trunk", repo: repository },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (!request.headers.get("User-Agent")) return new Response(null, { status: 403 });
      if (request.method === "POST") return Response.json(pr, { status: 201 });
      return Response.json(new URL(request.url).pathname.endsWith("/42") ? pr : []);
    }),
  );
  const api = createCanonicalPrApi({
    token: "synthetic-repository-token",
    repositoryFullName: repository.full_name,
    repositoryNumericId: repository.id,
    branchName: branch,
    baseBranch: "trunk",
    signal: new AbortController().signal,
  });
  expect(await api.find()).toBeNull();
  const created = await api.create({ title: "Build", body: "Done" });
  expect(created).toMatchObject({ number: 42, headSha, state: "open" });
  expect(await api.get(42)).toEqual(created);
  expect(requests.map((request) => request.headers.get("User-Agent"))).toEqual([
    "Wallie",
    "Wallie",
    "Wallie",
  ]);
});
