import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createFactoryImprovementReviewVerifier } from "./adoption-github";

const factoryId = "64000000-0000-4000-8000-000000000001";
const revisionId = "64000000-0000-4000-8000-000000000002";
const configFile = `${factoryId}.json`;
const target = {
  id: factoryId,
  repositoryId: revisionId,
  installationId: 59,
  repositoryFullName: "fixture/definitions",
  repositoryNumericId: 37,
  baseBranch: "test/config-base",
  headBranch: `wallie/improvements/${factoryId}/${revisionId}`,
  configPath: `.wallie/factory-definitions/${configFile}`,
};
const repository = { id: 37, full_name: "fixture/Definitions", default_branch: "main" };
const api = "https://api.github.com/repositories/37";
const baseRef = `/git/ref/heads/${target.baseBranch}`;
const headRef = `/git/ref/heads/${target.headBranch}`;
const reviewsPath = "/pulls/42/reviews?per_page=100&page=";
const writerPath = "/collaborators/reviewer/permission";
const headCommitSha = "a".repeat(40);
const headTreeSha = "b".repeat(40);
const baseCommitSha = "c".repeat(40);
const baseTreeSha = "d".repeat(40);
const mergeCommitSha = "e".repeat(40);
const branchTipSha = "f".repeat(40);
const oldDefinition = '{"prompt":"Prior"}';
const testedDefinition = '{ "prompt": "Follow the verified facts ☃" }\n';
const pullUrl = "https://github.com/fixture/definitions/pull/42";
const pullCreatedAt = "2026-01-01T10:00:00Z";
const reviewedAt = "2026-01-01T10:01:00Z";
const mergedAt = "2026-01-01T10:04:00Z";
const author = { id: 14, login: "author[bot]", type: "Bot" };
const reviewer = { id: 25, login: "reviewer", type: "User" };
const another = { id: 26, login: "another", type: "User" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const gitId = (value: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex");
const treeDir = (path: string, sha: string) => ({ path, sha, mode: "040000", type: "tree" });
const treeFile = (path: string, contents: string) => ({
  path,
  sha: gitId(contents),
  size: Buffer.byteLength(contents),
  mode: "100644",
  type: "blob",
});
const gitRef = (branch: string, sha: string) => ({
  ref: `refs/heads/${branch}`,
  object: { type: "commit", sha },
});
const gitCommit = (sha: string, tree: string, ...parents: string[]) => ({
  sha,
  tree: { sha: tree },
  parents: parents.map((parent) => ({ sha: parent })),
});
const hostedPull = {
  number: 42,
  html_url: pullUrl,
  state: "closed",
  draft: false,
  merged: true,
  created_at: pullCreatedAt,
  updated_at: mergedAt,
  merged_at: mergedAt,
  merge_commit_sha: mergeCommitSha,
  base: { ref: target.baseBranch, sha: baseCommitSha, repo: repository },
  head: { ref: target.headBranch, sha: headCommitSha, repo: repository },
  user: author,
};
const approval = {
  id: 95,
  state: "APPROVED",
  user: reviewer,
  commit_id: headCommitSha,
  submitted_at: reviewedAt,
};

function fixture() {
  const publication = {
    target,
    pullRequest: { number: 42, url: pullUrl, state: "draft" },
    base: { activationNumber: 8, revisionId: factoryId, digest: digest(oldDefinition) },
    candidate: { revisionId, digest: digest(testedDefinition) },
    baseCommitSha,
    baseTreeSha,
    headCommitSha,
    headTreeSha,
  } satisfies Parameters<typeof createFactoryImprovementReviewVerifier>[0]["publication"];
  const replies = new Map<string, unknown>([
    ["", repository],
    ["/pulls/42", hostedPull],
    [reviewsPath + "1", [approval]],
    [writerPath, { permission: "write", user: reviewer }],
    ["/collaborators/another/permission", { permission: "admin", user: another }],
    [baseRef, gitRef(target.baseBranch, mergeCommitSha)],
    [headRef, () => new Response(null, { status: 404 })],
    [`/git/commits/${mergeCommitSha}`, gitCommit(mergeCommitSha, headTreeSha, baseCommitSha)],
    [`/git/commits/${headCommitSha}`, gitCommit(headCommitSha, headTreeSha, baseCommitSha)],
    [`/git/commits/${baseCommitSha}`, gitCommit(baseCommitSha, baseTreeSha, "0".repeat(40))],
  ]);
  const oldWallie = "1".repeat(40);
  const oldDefinitions = "2".repeat(40);
  const newWallie = "3".repeat(40);
  const newDefinitions = "4".repeat(40);
  function setTree(treeSha: string, entries: unknown[]) {
    replies.set(`/git/trees/${treeSha}`, { sha: treeSha, tree: entries, truncated: false });
  }
  function putBlob(contents: string) {
    replies.set(`/git/blobs/${gitId(contents)}`, {
      sha: gitId(contents),
      size: Buffer.byteLength(contents),
      encoding: "base64",
      content: Buffer.from(contents).toString("base64") + "\n",
    });
  }
  const sameRootFile = treeFile("README.md", "Shared notes");
  setTree(baseTreeSha, [treeDir(".wallie", oldWallie), sameRootFile]);
  setTree(oldWallie, [treeDir("factory-definitions", oldDefinitions)]);
  setTree(oldDefinitions, [treeFile(configFile, oldDefinition)]);
  setTree(headTreeSha, [treeDir(".wallie", newWallie), sameRootFile]);
  setTree(newWallie, [treeDir("factory-definitions", newDefinitions)]);
  setTree(newDefinitions, [treeFile(configFile, testedDefinition)]);
  putBlob(oldDefinition);
  putBlob(testedDefinition);

  const requests: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(request.url.startsWith(api)).toBe(true);
    const path = request.url.slice(api.length);
    if (!replies.has(path)) throw new Error(`Unexpected fixture path ${path}`);
    const response = replies.get(path);
    return typeof response === "function" ? response() : Response.json(response);
  });
  const signal = new AbortController().signal;
  const verifier = createFactoryImprovementReviewVerifier({
    publication,
    token: "installation-fixture",
    signal,
    fetcher,
  });
  return { verifier, requests, replies, setTree, putBlob, newDefinitions, newWallie };
}

describe("factory improvement GitHub adoption proof", () => {
  it("returns the exact file bytes and independent current human approval for a merged squash", async () => {
    const { verifier, requests } = fixture();
    const { proof, definitionJson } = await verifier.read();
    expect(definitionJson).toBe(testedDefinition);
    expect(proof).toMatchObject({
      repositoryNumericId: 37,
      pullNumber: 42,
      pullUrl,
      baseCommitSha,
      headCommitSha,
      mergeCommitSha,
      reviewerId: reviewer.id,
      reviewerLogin: reviewer.login,
      reviewId: "95",
      reviewedAt,
      mergedAt,
    });
    expect(Date.parse(proof.observedAt)).toBeGreaterThanOrEqual(Date.parse(mergedAt));
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    await expect(verifier.assertCurrent(proof)).resolves.toBeUndefined();
  });

  it("accepts an exact two-parent merge still contained by a target with unrelated subsequent changes", async () => {
    const { verifier, replies, setTree, newWallie } = fixture();
    const tipTree = "5".repeat(40);
    replies.set(
      `/git/commits/${mergeCommitSha}`,
      gitCommit(mergeCommitSha, headTreeSha, baseCommitSha, headCommitSha),
    );
    replies.set(baseRef, gitRef(target.baseBranch, branchTipSha));
    replies.set(`/git/commits/${branchTipSha}`, gitCommit(branchTipSha, tipTree, mergeCommitSha));
    replies.set(`/compare/${mergeCommitSha}...${branchTipSha}?per_page=1`, {
      status: "ahead",
      base_commit: { sha: mergeCommitSha },
      merge_base_commit: { sha: mergeCommitSha },
      ahead_by: 1,
      behind_by: 0,
    });
    setTree(tipTree, [treeDir(".wallie", newWallie), treeFile("README.md", "Updated notes")]);
    await expect(verifier.read()).resolves.toMatchObject({ definitionJson: testedDefinition });
  });

  it.each([
    { ...hostedPull, state: "open", draft: true, merged: false, merged_at: null },
    { ...hostedPull, merged: false, merged_at: null },
    {
      ...hostedPull,
      head: { ...hostedPull.head, sha: branchTipSha },
    },
    {
      ...hostedPull,
      base: { ...hostedPull.base, repo: { ...repository, id: 38 } },
    },
    {
      ...hostedPull,
      base: { ...hostedPull.base, sha: branchTipSha },
    },
    { ...hostedPull, created_at: "2026-01-02T10:00:00Z" },
  ])("rejects a pull request that does not prove the frozen merge identity", async (pull) => {
    const { verifier, replies } = fixture();
    replies.set("/pulls/42", pull);
    await expect(verifier.read()).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("rejects a force-pushed review ref even when GitHub retains the original merged head", async () => {
    const { verifier, replies } = fixture();
    const { proof } = await verifier.read();
    replies.set(headRef, gitRef(target.headBranch, branchTipSha));
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it.each([
    gitCommit(mergeCommitSha, headTreeSha, branchTipSha),
    gitCommit(mergeCommitSha, headTreeSha, baseCommitSha, branchTipSha),
    gitCommit(mergeCommitSha, baseTreeSha, baseCommitSha, headCommitSha),
  ])("rejects an actual merge with unexpected parents or tree", async (commit) => {
    const { verifier, replies } = fixture();
    replies.set(`/git/commits/${mergeCommitSha}`, commit);
    await expect(verifier.read()).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("rejects digest drift even when the pull request metadata still references the expected head", async () => {
    const { verifier, setTree, putBlob, newDefinitions } = fixture();
    const altered = '{ "prompt": "Unreviewed" }';
    putBlob(altered);
    setTree(newDefinitions, [treeFile(configFile, altered)]);
    await expect(verifier.read()).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("rejects a current target whose ancestry has lost the recorded merge", async () => {
    const { verifier, replies } = fixture();
    const { proof } = await verifier.read();
    replies.set(baseRef, gitRef(target.baseBranch, branchTipSha));
    replies.set(`/compare/${mergeCommitSha}...${branchTipSha}?per_page=1`, {
      status: "diverged",
      base_commit: { sha: mergeCommitSha },
      merge_base_commit: { sha: baseCommitSha },
      ahead_by: 2,
      behind_by: 1,
    });
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("rejects a target that loses the merge while GitHub returns unchanged pull metadata", async () => {
    const { verifier, replies } = fixture();
    const { proof } = await verifier.read();
    let pullReads = 0;
    replies.set("/pulls/42", () => {
      pullReads += 1;
      if (pullReads === 2) replies.set(baseRef, gitRef(target.baseBranch, branchTipSha));
      return Response.json(hostedPull);
    });
    replies.set(`/compare/${mergeCommitSha}...${branchTipSha}?per_page=1`, {
      status: "diverged",
      base_commit: { sha: mergeCommitSha },
      merge_base_commit: { sha: baseCommitSha },
      ahead_by: 2,
      behind_by: 1,
    });

    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("rejects later changes to the live definition even while the target contains the merge", async () => {
    const { verifier, replies, setTree, putBlob } = fixture();
    const { proof } = await verifier.read();
    const drift = '{"prompt":"Different after merge"}';
    const tipTree = "5".repeat(40);
    const tipWallie = "6".repeat(40);
    const tipDefinitions = "7".repeat(40);
    replies.set(baseRef, gitRef(target.baseBranch, branchTipSha));
    replies.set(`/git/commits/${branchTipSha}`, gitCommit(branchTipSha, tipTree, mergeCommitSha));
    replies.set(`/compare/${mergeCommitSha}...${branchTipSha}?per_page=1`, {
      status: "ahead",
      base_commit: { sha: mergeCommitSha },
      merge_base_commit: { sha: mergeCommitSha },
      ahead_by: 1,
      behind_by: 0,
    });
    setTree(tipTree, [treeDir(".wallie", tipWallie)]);
    setTree(tipWallie, [treeDir("factory-definitions", tipDefinitions)]);
    setTree(tipDefinitions, [treeFile(configFile, drift)]);
    putBlob(drift);
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it.each([
    { ...approval, commit_id: branchTipSha },
    { ...approval, user: { ...reviewer, id: author.id } },
    { ...approval, user: { ...reviewer, type: "Bot" } },
    { ...approval, submitted_at: "2026-01-01T09:59:00Z" },
    { ...approval, submitted_at: "2026-01-01T10:05:00Z" },
  ])("rejects stale, self, bot, or mis-timed approval", async (review) => {
    const { verifier, replies } = fixture();
    replies.set(reviewsPath + "1", [review]);
    await expect(verifier.read()).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("requires explicit valid timestamps from the approval response", async () => {
    const { verifier, replies } = fixture();
    replies.set(reviewsPath + "1", [{ ...approval, submitted_at: "2026-01-01T10:01:00" }]);
    await expect(verifier.read()).rejects.toMatchObject({ code: "remote_unavailable" });
  });

  it("rechecks the reviewer's current repository push authority", async () => {
    const { verifier, replies } = fixture();
    const { proof } = await verifier.read();
    replies.set(writerPath, { permission: "read", user: reviewer });
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it.each([
    { ...approval, id: 96, state: "DISMISSED", submitted_at: "2026-01-01T10:02:00Z" },
    { ...approval, id: 96, commit_id: branchTipSha, submitted_at: "2026-01-01T10:02:00Z" },
    {
      ...approval,
      id: 96,
      state: "CHANGES_REQUESTED",
      user: another,
      submitted_at: "2026-01-01T10:02:00Z",
    },
  ])("rechecks latest decisive reviews and current change requests", async (review) => {
    const { verifier, replies } = fixture();
    const { proof } = await verifier.read();
    replies.set(reviewsPath + "1", [approval, review]);
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({ code: "review_conflict" });
  });

  it("reads successive review pages and ignores a non-decisive comment", async () => {
    const { verifier, replies, requests } = fixture();
    replies.set(reviewsPath + "1", () =>
      Response.json([approval], {
        headers: { Link: '<https://example.test/ignored>; rel="next"' },
      }),
    );
    replies.set(reviewsPath + "2", [{ id: 96, state: "COMMENTED", user: reviewer }]);
    await expect(verifier.read()).resolves.toMatchObject({ proof: { reviewId: "95" } });
    expect(requests.some((request) => request.url === api + reviewsPath + "2")).toBe(true);
  });

  it("accepts a full final review page and rejects a continuation beyond the review limit", async () => {
    const { verifier, replies } = fixture();
    let hasFurtherReviews = false;
    for (let page = 1; page <= 5; page += 1) {
      const comments = Array.from({ length: page === 5 ? 99 : 100 }, (_, index) => ({
        id: page * 100 + index,
        state: "COMMENTED",
      }));
      const reviews = page === 5 ? [...comments, approval] : comments;
      replies.set(reviewsPath + page, () =>
        Response.json(reviews, {
          headers:
            page < 5 || hasFurtherReviews
              ? { Link: `<${api}${reviewsPath}${page + 1}>; rel="next"` }
              : {},
        }),
      );
    }

    const { proof } = await verifier.read();
    expect(proof.reviewId).toBe("95");
    hasFurtherReviews = true;
    await expect(verifier.assertCurrent(proof)).rejects.toMatchObject({
      code: "remote_unavailable",
    });
  });

  it("fails closed on duplicated identities across review pages", async () => {
    const { verifier, replies } = fixture();
    replies.set(reviewsPath + "1", () =>
      Response.json([approval], {
        headers: { Link: '<https://example.test/ignored>; rel="next"' },
      }),
    );
    replies.set(reviewsPath + "2", [approval]);
    await expect(verifier.read()).rejects.toMatchObject({ code: "remote_unavailable" });
  });
});
