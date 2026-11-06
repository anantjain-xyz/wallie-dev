import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DeliveryRequirements } from "@/lib/delivery-policy/contracts";

import { collectPrVerification, PrVerificationApiError } from "./pr-verification-api";

const head = "a".repeat(40);
const base = "b".repeat(40);
const mergeSha = "c".repeat(40);
const now = "2026-11-06T12:00:00Z";
const repository = { id: 777, full_name: "acme/app" };
const branch = "wallie/sessions/session/epoch";
const requirements: DeliveryRequirements = {
  version: 1,
  deliveryMode: "code",
  requiredChecks: ["ci"],
  minimumApprovals: 0,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: [],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: true,
};

function pr() {
  return {
    number: 42,
    html_url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    merged_at: null as string | null,
    mergeable: true as boolean | null,
    mergeable_state: "clean",
    updated_at: now,
    head: { ref: branch, sha: head, repo: { ...repository } as typeof repository | null },
    base: { ref: "main", sha: base, repo: { ...repository } },
  };
}
function check(overrides = {}) {
  return {
    id: 10,
    name: "ci",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    completed_at: now,
    app: { id: 123, slug: "acme-ci" },
    check_suite: { id: 1 },
    ...overrides,
  };
}
const done = { hasNextPage: false, endCursor: null };
function graph() {
  return {
    data: {
      repository: {
        databaseId: 777,
        nameWithOwner: "acme/app",
        pullRequest: {
          number: 42,
          headRefOid: head,
          baseRefOid: base,
          isDraft: false,
          state: "OPEN",
          reviewDecision: null as "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          baseRef: { name: "main", branchProtectionRule: null as { id: string } | null },
          potentialMergeCommit: null as {
            oid: string;
            parents: { nodes: { oid: string }[]; pageInfo: typeof done };
          } | null,
          latestOpinionatedReviews: {
            nodes: [] as ReturnType<typeof review>[],
            pageInfo: { ...done } as { hasNextPage: boolean; endCursor: string | null },
          },
          reviewThreads: {
            nodes: [] as { id: string; isResolved: boolean; isOutdated: boolean }[],
            pageInfo: { ...done } as { hasNextPage: boolean; endCursor: string | null },
          },
        },
      },
    },
  };
}
function review(overrides = {}) {
  return {
    id: "review-1",
    state: "APPROVED",
    author: { login: "reviewer" },
    authorCanPushToRepository: true,
    commit: { oid: head },
    ...overrides,
  };
}
function setup() {
  const controller = new AbortController();
  const input = {
    token: "private-app-token",
    repositoryFullName: "acme/app",
    repositoryNumericId: 777,
    prNumber: 42,
    branchName: branch,
    baseBranch: "main",
    signal: controller.signal,
    requirements: { ...requirements },
    installationPermissions: {
      contents: "read",
      checks: "read",
      statuses: "read",
      pull_requests: "read",
      administration: "read",
      actions: "read",
    } as Record<string, string>,
  };
  const pulls = [pr(), pr()];
  const graphs = [graph()];
  const routes = new Map<string, unknown>([
    ["/rules/branches/main", []],
    ["/branches/main/protection", new Response(null, { status: 404 })],
    [`/commits/${head}/check-runs`, { check_runs: [check()] }],
    [`/commits/${head}/statuses`, []],
    [
      "/actions/runs",
      { workflow_runs: [{ id: 100, check_suite_id: 1, head_sha: head, event: "pull_request" }] },
    ],
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const parsed = new URL(String(url));
    let value: unknown;
    if (parsed.pathname === "/graphql") {
      value = graphs.shift();
    } else if (parsed.pathname === "/repos/acme/app/pulls/42") value = pulls.shift();
    else value = routes.get(parsed.pathname.replace("/repos/acme/app", ""));
    if (value instanceof Error) throw value;
    if (typeof value === "function") value = value(parsed, options);
    if (value === undefined) throw new Error("Unexpected request");
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Response)
    ) {
      let fixture: Record<string, unknown> = { ...value };
      if ("check_runs" in fixture && !("total_count" in fixture))
        fixture = { ...fixture, total_count: (fixture.check_runs as unknown[]).length };
      else if ("workflow_runs" in fixture && !("total_count" in fixture))
        fixture = { ...fixture, total_count: (fixture.workflow_runs as unknown[]).length };
      if (parsed.pathname.endsWith("/protection") && !("url" in fixture))
        fixture = {
          ...fixture,
          url: "https://api.github.com/repos/acme/app/branches/main/protection",
        };
      value = fixture;
    }
    return value instanceof Response ? value : Response.json(value);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    input,
    pulls,
    graphs,
    routes,
    fetch,
    controller,
    collect: () => collectPrVerification(input),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("collects exact scoped current evidence without exposing a readiness decision or performing GitHub mutations", async () => {
  const { collect, fetch } = setup();
  const result = await collect();
  expect(result).toMatchObject({
    headSha: head,
    baseSha: base,
    state: "open",
    draft: false,
    payload: {
      githubAccess: "available",
      checks: "passed",
      reviews: "passed",
      threads: "passed",
      mergeability: "passed",
      protection: "verified",
      blockers: [],
    },
  });
  expect(result.payload).not.toHaveProperty("ready");
  for (const [url, options] of fetch.mock.calls) {
    expect(new URL(String(url)).origin).toBe("https://api.github.com");
    expect(options).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer private-app-token" },
      signal: expect.any(AbortSignal),
    });
    expect(options?.method).toBe(String(url).endsWith("graphql") ? "POST" : "GET");
  }
  expect(
    fetch.mock.calls.some(([url]) => String(url).includes(`/commits/${head}/check-runs`)),
  ).toBe(true);
});

it.each(["success", "neutral", "skipped"])(
  "allows GitHub's completed %s conclusion",
  async (conclusion) => {
    const { collect, routes } = setup();
    routes.set(`/commits/${head}/check-runs`, { check_runs: [check({ conclusion })] });
    expect((await collect()).payload.checks).toBe("passed");
  },
);

it.each([
  { status: "in_progress", conclusion: null, expected: "checking" },
  { status: "completed", conclusion: "failure", expected: "blocked" },
  { status: "completed", conclusion: "cancelled", expected: "blocked" },
  { status: "completed", conclusion: "timed_out", expected: "blocked" },
  { status: "completed", conclusion: "action_required", expected: "blocked" },
  { status: "completed", conclusion: "new_unknown_conclusion", expected: "blocked" },
])(
  "does not pass incomplete or unsuccessful check $conclusion/$status",
  async ({ expected, ...overrides }) => {
    const { collect, routes } = setup();
    routes.set(`/commits/${head}/check-runs`, { check_runs: [check(overrides)] });
    expect((await collect()).payload.checks).toBe(expected);
  },
);

it("does not vacuously pass empty check lists even when the configured required list is deliberately empty", async () => {
  const { collect, input, routes } = setup();
  input.requirements.requiredChecks = [];
  routes.set(`/commits/${head}/check-runs`, { check_runs: [] });
  expect((await collect()).payload).toMatchObject({
    checks: "unknown",
    blockers: [{ code: "github_checks_empty" }],
  });
});

it("reports missing named checks as checking", async () => {
  const { collect, input } = setup();
  input.requirements.requiredChecks = ["absent"];
  expect((await collect()).payload).toMatchObject({
    checks: "checking",
    blockers: [{ code: "github_required_check_missing", requirement: "absent" }],
  });
});

it("uses the latest rerun for each name and source App regardless of response ordering", async () => {
  const { collect, routes } = setup();
  routes.set(`/commits/${head}/check-runs`, {
    check_runs: [check({ id: 30, conclusion: "failure" }), check({ id: 20 }), check({ id: 10 })],
  });
  expect((await collect()).payload.checks).toBe("blocked");
});

it("requires a status and check with the same name to both pass", async () => {
  const { collect, routes } = setup();
  routes.set(`/commits/${head}/statuses`, [
    { id: 20, context: "ci", state: "failure", updated_at: now },
    { id: 10, context: "ci", state: "success", updated_at: now },
  ]);
  expect((await collect()).payload.checks).toBe("blocked");
});

it("rejects old-head check runs returned from the exact current-head endpoint", async () => {
  const { collect, routes } = setup();
  routes.set(`/commits/${head}/check-runs`, { check_runs: [check({ head_sha: "d".repeat(40) })] });
  await expect(collect()).rejects.toMatchObject({ code: "github_identity_mismatch" });
});

it("does not pass check receipts more than seven days old", async () => {
  const { collect, routes } = setup();
  routes.set(`/commits/${head}/check-runs`, {
    check_runs: [check({ completed_at: "2026-10-01T12:00:00Z" })],
  });
  expect((await collect()).payload.checks).toBe("unknown");
});

it.each([123, 987])("matches ruleset required check App identity %i", async (integrationId) => {
  const { collect, routes } = setup();
  routes.set("/rules/branches/main", [
    {
      type: "required_status_checks",
      ruleset_id: 5,
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: "ci", integration_id: integrationId }],
      },
    },
  ]);
  expect((await collect()).payload.checks).toBe(integrationId === 123 ? "passed" : "checking");
});

it("a successful legacy status cannot impersonate a source-pinned required App check", async () => {
  const { collect, routes } = setup();
  routes.set("/rules/branches/main", [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: "ci", integration_id: 987 }],
      },
    },
  ]);
  routes.set(`/commits/${head}/statuses`, [
    { id: 1, context: "ci", state: "success", updated_at: now },
  ]);
  expect((await collect()).payload.checks).toBe("checking");
});

it("verifies classic required-check App IDs and records unsupported repository policies", async () => {
  const { collect, graphs, routes } = setup();
  graphs[0].data.repository.pullRequest.baseRef.branchProtectionRule = { id: "classic-rule" };
  routes.set("/branches/main/protection", {
    required_status_checks: {
      strict: true,
      contexts: ["ci"],
      checks: [{ context: "ci", app_id: 123 }],
    },
  });
  expect((await collect()).payload).toMatchObject({
    checks: "passed",
    requiredChecks: [
      { context: "ci", appId: null, source: "policy" },
      { context: "ci", appId: 123, source: "branch_protection" },
    ],
  });
});

it("classic contexts without verified source identities remain explicitly unknown", async () => {
  const { collect, graphs, routes } = setup();
  graphs[0].data.repository.pullRequest.baseRef.branchProtectionRule = { id: "classic-rule" };
  routes.set("/branches/main/protection", {
    required_status_checks: { strict: false, contexts: ["ci"] },
  });
  expect((await collect()).payload).toMatchObject({
    protection: "unknown",
    checks: "unknown",
    blockers: [{ code: "github_required_check_source_unknown", requirement: "ci" }],
  });
});

it("does not call inaccessible classic protection or infer no protection from missing administration permission", async () => {
  const { collect, input, fetch } = setup();
  delete input.installationPermissions.administration;
  expect((await collect()).payload).toMatchObject({ protection: "unknown", checks: "unknown" });
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/protection"))).toBe(false);
});

it("a protection 404 cannot erase a known applicable classic rule", async () => {
  const { collect, graphs } = setup();
  graphs[0].data.repository.pullRequest.baseRef.branchProtectionRule = { id: "classic-rule" };
  expect((await collect()).payload).toMatchObject({
    protection: "unknown",
    blockers: [{ code: "github_branch_protection_unavailable" }],
  });
});

it("unknown active rules are explicit, nonpassing policy", async () => {
  const { collect, routes } = setup();
  routes.set("/rules/branches/main", [{ type: "merge_queue", parameters: {} }]);
  expect((await collect()).payload).toMatchObject({
    protection: "unknown",
    checks: "unknown",
    blockers: [{ code: "github_rule_unsupported", requirement: "merge_queue" }],
  });
});

it.each(["head", "base", "draft", "updated", "mergeability"])(
  "rejects a PR %s change during collection",
  async (change) => {
    const { collect, pulls } = setup();
    if (change === "head") pulls[1].head.sha = "e".repeat(40);
    if (change === "base") pulls[1].base.sha = "e".repeat(40);
    if (change === "draft") pulls[1].draft = true;
    if (change === "updated") pulls[1].updated_at = "2026-11-06T12:01:00Z";
    if (change === "mergeability") pulls[1].mergeable = false;
    await expect(collect()).rejects.toMatchObject({ code: "github_changed_during_refresh" });
  },
);

it.each(["repo", "number", "base", "url", "headrepo"])(
  "rejects a mismatching canonical %s identity",
  async (change) => {
    const { collect, pulls } = setup();
    if (change === "repo") pulls[0].base.repo.id = 888;
    if (change === "number") pulls[0].number = 43;
    if (change === "base") pulls[0].base.ref = "wrong-base";
    if (change === "url") pulls[0].html_url = "https://evil.example/acme/app/pull/42";
    if (change === "headrepo") pulls[0].head.repo = { id: 777, full_name: "other/app" };
    await expect(collect()).rejects.toMatchObject({ code: "github_identity_mismatch" });
  },
);

it("counts only verified writers' current-head approvals and does not infer code-owner approval", async () => {
  const { collect, input, graphs } = setup();
  input.requirements = { ...requirements, minimumApprovals: 1, requireCodeOwnerReview: true };
  graphs[0].data.repository.pullRequest.reviewDecision = "APPROVED";
  graphs[0].data.repository.pullRequest.latestOpinionatedReviews.nodes = [
    review({ commit: { oid: base } }),
    review({ id: "reader", author: { login: "reader" }, authorCanPushToRepository: false }),
  ];
  expect((await collect()).payload).toMatchObject({
    reviews: "unknown",
    reviewEvidence: { currentHeadApprovals: 0 },
  });
});

it("keeps requested changes and outdated unresolved review threads blocking", async () => {
  const { collect, graphs } = setup();
  graphs[0].data.repository.pullRequest.latestOpinionatedReviews.nodes = [
    review({ state: "CHANGES_REQUESTED" }),
  ];
  graphs[0].data.repository.pullRequest.reviewThreads.nodes = [
    { id: "thread", isResolved: false, isOutdated: true },
  ];
  expect((await collect()).payload).toMatchObject({ reviews: "blocked", threads: "blocked" });
});

it("paginates reviews and threads independently and preserves later unresolved threads", async () => {
  const { collect, graphs, fetch } = setup();
  graphs[0].data.repository.pullRequest.reviewThreads.pageInfo = {
    hasNextPage: true,
    endCursor: "next-thread",
  };
  const second = graph();
  second.data.repository.pullRequest.reviewThreads.nodes = [
    { id: "later", isResolved: false, isOutdated: false },
  ];
  graphs.push(second);
  expect((await collect()).payload.threads).toBe("blocked");
  const requests = fetch.mock.calls.filter(([url]) => String(url).endsWith("/graphql"));
  expect(JSON.parse(String(requests[1][1]?.body)).variables).toMatchObject({
    readReviews: false,
    readThreads: true,
    threads: "next-thread",
  });
});

it("rejects mixed GraphQL identities and incomplete/error-bearing GraphQL data", async () => {
  const { collect, graphs } = setup();
  graphs[0].data.repository.databaseId = 888;
  await expect(collect()).rejects.toMatchObject({ code: "github_changed_during_refresh" });
});

it("test-merge check failures supersede successful current-head checks", async () => {
  const { collect, graphs, routes } = setup();
  graphs[0].data.repository.pullRequest.potentialMergeCommit = {
    oid: mergeSha,
    parents: { nodes: [{ oid: base }, { oid: head }], pageInfo: done },
  };
  routes.set(`/commits/${mergeSha}/check-runs`, {
    check_runs: [check({ head_sha: mergeSha, conclusion: "failure" })],
  });
  routes.set(`/commits/${mergeSha}/statuses`, []);
  expect((await collect()).payload).toMatchObject({
    checks: "blocked",
    checkEvidence: { selectedSha: mergeSha },
  });
});

it("rejects a test-merge receipt generated from a different base", async () => {
  const { collect, graphs } = setup();
  graphs[0].data.repository.pullRequest.potentialMergeCommit = {
    oid: mergeSha,
    parents: { nodes: [{ oid: mergeSha }, { oid: head }], pageInfo: done },
  };
  await expect(collect()).rejects.toMatchObject({ code: "github_changed_during_refresh" });
});

it.each(["pull_request", "workflow_dispatch"])(
  "verifies Actions %s event provenance",
  async (event) => {
    const { collect, routes } = setup();
    routes.set(`/commits/${head}/check-runs`, {
      check_runs: [check({ app: { id: 15368, slug: "github-actions" } })],
    });
    routes.set("/actions/runs", {
      workflow_runs: [{ id: 100, check_suite_id: 1, head_sha: head, event }],
    });
    expect((await collect()).payload.checks).toBe(event === "pull_request" ? "passed" : "blocked");
  },
);

it("Actions checks remain unknown when run-event permissions are missing", async () => {
  const { collect, input, routes } = setup();
  delete input.installationPermissions.actions;
  routes.set(`/commits/${head}/check-runs`, {
    check_runs: [check({ app: { id: 15368, slug: "github-actions" } })],
  });
  expect((await collect()).payload).toMatchObject({
    checks: "unknown",
    blockers: [{ code: "github_actions_provenance_unknown", requirement: "ci" }],
  });
});

it.each(["UNKNOWN", "CONFLICTING"])("does not pass %s mergeability", async (mergeable) => {
  const { collect, graphs, pulls } = setup();
  graphs[0].data.repository.pullRequest.mergeable = mergeable;
  pulls[0].mergeable = pulls[1].mergeable = mergeable === "UNKNOWN" ? null : false;
  expect((await collect()).payload.mergeability).toBe(
    mergeable === "UNKNOWN" ? "unknown" : "blocked",
  );
});

it.each([
  { status: 401, code: "github_access_denied" },
  { status: 403, code: "github_access_denied" },
  { status: 404, code: "github_not_found" },
  { status: 429, code: "github_rate_limited" },
  { status: 500, code: "github_unavailable" },
])("sanitizes HTTP $status errors", async ({ status, code }) => {
  const { collect, routes } = setup();
  routes.set(
    "/rules/branches/main",
    Response.json({ private: "private-app-token provider details" }, { status }),
  );
  await expect(collect()).rejects.toMatchObject({ code, status });
  await expect(
    Promise.reject(new PrVerificationApiError(code as "github_unavailable", status)),
  ).rejects.not.toThrow(/private-app-token/);
});

it("recognizes a rate-limited 403 from headers", async () => {
  const { collect, routes } = setup();
  routes.set(
    "/rules/branches/main",
    new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
  );
  await expect(collect()).rejects.toMatchObject({ code: "github_rate_limited", status: 403 });
});

it("fails before requests when required App permission is missing", async () => {
  const { collect, input, fetch } = setup();
  delete input.installationPermissions.checks;
  await expect(collect()).rejects.toMatchObject({ code: "github_permission_missing" });
  expect(fetch).not.toHaveBeenCalled();
});

it("never follows provider redirect URLs with the installation token", async () => {
  const { collect, routes } = setup();
  routes.set(
    "/rules/branches/main",
    new Response(null, { status: 302, headers: { location: "https://evil.example/token" } }),
  );
  await expect(collect()).rejects.toMatchObject({ code: "github_unavailable", status: 302 });
});

it("bounds REST pagination and constructs all page URLs itself", async () => {
  const { collect, routes, fetch } = setup();
  routes.set("/rules/branches/main", () =>
    Response.json([], { headers: { link: '<https://evil.example/token>; rel="next"' } }),
  );
  await expect(collect()).rejects.toMatchObject({ code: "github_pagination_limit" });
  expect(fetch.mock.calls.filter(([url]) => String(url).includes("/rules/branches/"))).toHaveLength(
    5,
  );
  expect(
    fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "api.github.com"),
  ).toBe(true);
});

it("rejects a truncated check envelope even when the partial visible list is successful", async () => {
  const { collect, routes } = setup();
  routes.set(`/commits/${head}/check-runs`, { total_count: 2, check_runs: [check()] });
  await expect(collect()).rejects.toMatchObject({ code: "github_invalid_response" });
});

it("rejects oversized response bodies before decoding", async () => {
  const { collect, routes } = setup();
  routes.set(
    "/rules/branches/main",
    new Response("[]", { headers: { "content-length": "99999999" } }),
  );
  await expect(collect()).rejects.toMatchObject({ code: "github_invalid_response" });
});

it("bounds a provider that never settles fetch", async () => {
  const { collect } = setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => undefined)),
  );
  const work = collect();
  const rejected = expect(work).rejects.toMatchObject({ code: "github_request_aborted" });
  await vi.advanceTimersByTimeAsync(12_001);
  await rejected;
});

it("does not start a request for an already aborted collection", async () => {
  const { collect, controller, fetch } = setup();
  controller.abort();
  await expect(collect()).rejects.toMatchObject({ code: "github_request_aborted" });
  expect(fetch).not.toHaveBeenCalled();
});
