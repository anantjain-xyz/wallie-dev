import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "@/lib/sandbox/commit-author";

import {
  createImprovementPublicationGitHub,
  ImprovementPublicationGitHubError,
  type ImprovementPublicationGitHubTarget,
} from "./publication-github";

const factoryId = "63900000-0000-4000-8000-000000000001";
const revisionId = "63900000-0000-4000-8000-000000000002";
const target: ImprovementPublicationGitHubTarget = {
  repositoryFullName: "Fixture/definitions",
  repositoryNumericId: 37,
  baseBranch: "test/config-base",
  headBranch: `wallie/improvements/${factoryId}/${revisionId}`,
  configPath: `.wallie/factory-definitions/${factoryId}.json`,
};
const apiRoot = "https://api.github.com/repositories/37";
const token = "fixture-token";
const baseContents = '{"prompt":"Original"}';
const candidateContents = '{"prompt":"Use the observed facts ☃"}';
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const blobSha = (value: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex");
const base = { commitSha: "a".repeat(40), treeSha: "b".repeat(40), fileSha256: hash(baseContents) };
const head = { commitSha: "c".repeat(40), treeSha: "d".repeat(40) };
const candidateDigest = hash(candidateContents);
const message = "Prepare exact reviewed factory improvement";
const committedAt = "2026-11-22T07:00:00.912+00:00";
const identity = { ...WALLIE_GITHUB_BOT_COMMIT_AUTHOR, date: "2026-11-22T07:00:00Z" };
const command = { base, definitionJson: candidateContents, candidateDigest, message, committedAt };
const verifyCommand = { base, head, candidateDigest };
const basePath = `/git/ref/heads/${target.baseBranch}`;
const headPath = `/git/ref/heads/${target.headBranch}`;
const repository = { id: 37, full_name: "fixture/Definitions", default_branch: "main" };
const pullNumber = 42;
const pullUrl = "https://github.com/fixture/definitions/pull/42";

function treeNode(path: string, sha: string) {
  return { path, sha, mode: "040000", type: "tree" };
}

function file(path: string, sha: string, size: number, mode = "100644") {
  return { path, sha, size, mode, type: "blob" };
}

function gitRef(branch: string, sha: string) {
  return { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } };
}

function gitBlob(content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    sha: blobSha(content),
    size: bytes.byteLength,
    encoding: "base64",
    content: bytes.toString("base64") + "\n",
  };
}

function hostedPullRequest() {
  return {
    number: pullNumber,
    html_url: pullUrl,
    state: "open",
    draft: true,
    updated_at: "2026-11-22T07:01:00Z",
    merged_at: null,
    merged: false,
    base: { ref: target.baseBranch, sha: base.commitSha, repo: repository },
    head: { ref: target.headBranch, sha: head.commitSha, repo: repository },
  };
}

function fixture() {
  const oldWallie = "1".repeat(40);
  const oldDefinitions = "2".repeat(40);
  const newWallie = "3".repeat(40);
  const newDefinitions = "4".repeat(40);
  const unaffected = file("README.md", "5".repeat(40), 10);
  const unaffectedNested = file("settings.json", "6".repeat(40), 100);
  const unrelatedFactory = file("shared.json", "7".repeat(40), 30);
  const previousFile = file(
    `${factoryId}.json`,
    blobSha(baseContents),
    Buffer.byteLength(baseContents),
  );
  const nextFile = file(
    `${factoryId}.json`,
    blobSha(candidateContents),
    Buffer.byteLength(candidateContents),
  );
  const previousCommit = {
    sha: base.commitSha,
    tree: { sha: base.treeSha },
    parents: [{ sha: "0".repeat(40) }],
  };
  const nextCommit = {
    sha: head.commitSha,
    tree: { sha: head.treeSha },
    parents: [{ sha: base.commitSha }],
  };
  const replies = new Map<string, unknown>([
    ["GET ", repository],
    ["GET " + basePath, gitRef(target.baseBranch, base.commitSha)],
    ["GET " + headPath, gitRef(target.headBranch, head.commitSha)],
    ["GET /git/commits/" + base.commitSha, previousCommit],
    ["GET /git/commits/" + head.commitSha, nextCommit],
    [
      "GET /git/trees/" + base.treeSha,
      { sha: base.treeSha, tree: [unaffected, treeNode(".wallie", oldWallie)], truncated: false },
    ],
    [
      "GET /git/trees/" + oldWallie,
      {
        sha: oldWallie,
        tree: [unaffectedNested, treeNode("factory-definitions", oldDefinitions)],
        truncated: false,
      },
    ],
    [
      "GET /git/trees/" + oldDefinitions,
      { sha: oldDefinitions, tree: [previousFile, unrelatedFactory], truncated: false },
    ],
    [
      "GET /git/trees/" + head.treeSha,
      { sha: head.treeSha, tree: [treeNode(".wallie", newWallie), unaffected], truncated: false },
    ],
    [
      "GET /git/trees/" + newWallie,
      {
        sha: newWallie,
        tree: [treeNode("factory-definitions", newDefinitions), unaffectedNested],
        truncated: false,
      },
    ],
    [
      "GET /git/trees/" + newDefinitions,
      { sha: newDefinitions, tree: [unrelatedFactory, nextFile], truncated: false },
    ],
    ["GET /git/blobs/" + blobSha(baseContents), gitBlob(baseContents)],
    ["GET /git/blobs/" + blobSha(candidateContents), gitBlob(candidateContents)],
    ["POST /git/blobs", { sha: blobSha(candidateContents) }],
    ["POST /git/trees", { sha: head.treeSha }],
    ["POST /git/commits", nextCommit],
    ["POST /git/refs", gitRef(target.headBranch, head.commitSha)],
    ["GET /pulls/" + pullNumber, hostedPullRequest()],
  ]);
  const calls: Array<{ key: string; request: Request }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    if (!request.url.startsWith(apiRoot)) throw new Error("Unexpected GitHub request.");
    const key = request.method + " " + request.url.slice(apiRoot.length);
    calls.push({ key, request });
    if (!replies.has(key)) throw new Error("Unexpected GitHub test endpoint.");
    const response = replies.get(key);
    if (typeof response === "function") return response();
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    return Response.json(response, { status: request.method === "POST" ? 201 : 200 });
  });
  const transport = createImprovementPublicationGitHub({ target, token, fetcher });
  const writes = () => calls.filter(({ key }) => key.startsWith("POST "));
  return { transport, replies, calls, fetcher, writes, oldDefinitions, newDefinitions, nextFile };
}

function verify(transport: ReturnType<typeof createImprovementPublicationGitHub>) {
  return transport.verifyPullRequest({
    pullNumber,
    baseCommitSha: base.commitSha,
    headCommitSha: head.commitSha,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("improvement publication GitHub transport", () => {
  it("reads the configured base branch, immutable regular-file bytes and live default branch", async () => {
    const { transport, calls, writes } = fixture();
    await expect(transport.readBase()).resolves.toEqual({ ...base, defaultBranch: "main" });
    expect(writes()).toEqual([]);
    expect(calls.map(({ key }) => key)).toEqual([
      "GET ",
      "GET " + basePath,
      "GET /git/commits/" + base.commitSha,
      "GET /git/trees/" + base.treeSha,
      "GET /git/trees/" + "1".repeat(40),
      "GET /git/trees/" + "2".repeat(40),
      "GET /git/blobs/" + blobSha(baseContents),
      "GET " + basePath,
    ]);
    expect(
      calls.every(({ request }) => request.headers.get("authorization") === `Bearer ${token}`),
    ).toBe(true);
    expect(calls.every(({ request }) => request.redirect === "manual")).toBe(true);
  });

  it.each([
    { ...repository, id: 99 },
    { ...repository, full_name: "different/repository" },
    { ...repository, default_branch: target.baseBranch },
    { ...repository, default_branch: target.headBranch },
    { ...repository, archived: true },
  ])("refuses unusable repository authority before any Git write", async (identity) => {
    const { transport, replies, writes } = fixture();
    replies.set("GET ", identity);
    await expect(transport.prepareHead(command)).rejects.toMatchObject({
      code: "repository_mismatch",
    });
    expect(writes()).toEqual([]);
  });

  it("rejects target paths and review branches belonging to another factory", () => {
    expect(() =>
      createImprovementPublicationGitHub({
        target: { ...target, configPath: "factory-config.json" },
        token,
      }),
    ).toThrow(ImprovementPublicationGitHubError);
    expect(() =>
      createImprovementPublicationGitHub({
        target: { ...target, headBranch: target.headBranch.replace(factoryId, revisionId) },
        token,
      }),
    ).toThrow(ImprovementPublicationGitHubError);
  });

  it.each(["120000", "160000"])(
    "rejects a non-regular configuration path with mode %s",
    async (mode) => {
      const { transport, replies, oldDefinitions } = fixture();
      replies.set("GET /git/trees/" + oldDefinitions, {
        sha: oldDefinitions,
        truncated: false,
        tree: [
          file(factoryId + ".json", blobSha(baseContents), Buffer.byteLength(baseContents), mode),
        ],
      });
      await expect(transport.readBase()).rejects.toMatchObject({ code: "base_mismatch" });
    },
  );

  it("rejects a truncated tree or tampered blob instead of trusting its provider metadata", async () => {
    const truncated = fixture();
    truncated.replies.set("GET /git/trees/" + base.treeSha, {
      sha: base.treeSha,
      truncated: true,
      tree: [],
    });
    await expect(truncated.transport.readBase()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const tampered = fixture();
    tampered.replies.set("GET /git/blobs/" + blobSha(baseContents), {
      ...gitBlob(baseContents),
      content: Buffer.from('{"prompt":"Different"}').toString("base64"),
    });
    await expect(tampered.transport.readBase()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("prepares deterministic objects using the frozen base tree and exactly one tracked file", async () => {
    const { transport, writes } = fixture();
    await expect(transport.prepareHead(command)).resolves.toEqual(head);
    await expect(transport.prepareHead(command)).resolves.toEqual(head);
    const writesWithPayloads = await Promise.all(
      writes().map(async ({ key, request }) => [key, await request.json()]),
    );
    const sequence = [
      [
        "POST /git/blobs",
        { encoding: "base64", content: Buffer.from(candidateContents).toString("base64") },
      ],
      [
        "POST /git/trees",
        {
          base_tree: base.treeSha,
          tree: [
            {
              path: target.configPath,
              mode: "100644",
              type: "blob",
              sha: blobSha(candidateContents),
            },
          ],
        },
      ],
      [
        "POST /git/commits",
        {
          message,
          tree: head.treeSha,
          parents: [base.commitSha],
          author: identity,
          committer: identity,
        },
      ],
    ];
    expect(writesWithPayloads).toEqual([...sequence, ...sequence]);
  });

  it("rejects mismatched candidate bytes before contacting GitHub and a moved base before creating objects", async () => {
    const { transport, replies, calls, writes } = fixture();
    await expect(
      transport.prepareHead({ ...command, candidateDigest: "e".repeat(64) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toEqual([]);
    replies.set("GET " + basePath, gitRef(target.baseBranch, "e".repeat(40)));
    await expect(transport.prepareHead(command)).rejects.toMatchObject({ code: "base_mismatch" });
    expect(writes()).toEqual([]);
  });

  it("creates exactly the owned review ref on an exact prepared commit", async () => {
    const { transport, replies, writes } = fixture();
    replies.set("GET " + headPath, () => new Response(null, { status: 404 }));
    await expect(transport.ensureHeadRef({ head })).resolves.toBeUndefined();
    expect(writes().map(({ key }) => key)).toEqual(["POST /git/refs"]);
    await expect(writes()[0]?.request.json()).resolves.toEqual({
      ref: `refs/heads/${target.headBranch}`,
      sha: head.commitSha,
    });
  });

  it("reconciles a lost create-ref response to the exact head and never sends a second write", async () => {
    const { transport, replies, writes } = fixture();
    replies.set("GET " + headPath, () => new Response(null, { status: 404 }));
    replies.set("POST /git/refs", () => {
      replies.set("GET " + headPath, gitRef(target.headBranch, head.commitSha));
      throw new Error("Unknown GitHub network outcome.");
    });
    await expect(transport.ensureHeadRef({ head })).resolves.toBeUndefined();
    await expect(transport.ensureHeadRef({ head })).resolves.toBeUndefined();
    expect(writes().map(({ key }) => key)).toEqual(["POST /git/refs"]);
    await expect(writes()[0]?.request.json()).resolves.toEqual({
      ref: `refs/heads/${target.headBranch}`,
      sha: head.commitSha,
    });
  });

  it("never updates an existing conflicting branch, including a branch found after a create race", async () => {
    const alreadyPresent = fixture();
    alreadyPresent.replies.set("GET " + headPath, gitRef(target.headBranch, "e".repeat(40)));
    await expect(alreadyPresent.transport.ensureHeadRef({ head })).rejects.toMatchObject({
      code: "head_conflict",
    });
    expect(alreadyPresent.writes()).toEqual([]);
    const raced = fixture();
    raced.replies.set("GET " + headPath, () => new Response(null, { status: 404 }));
    raced.replies.set("POST /git/refs", () => {
      raced.replies.set("GET " + headPath, gitRef(target.headBranch, "f".repeat(40)));
      return new Response("GitHub private error detail", { status: 422 });
    });
    await expect(raced.transport.ensureHeadRef({ head })).rejects.toMatchObject({
      code: "head_conflict",
    });
    expect(raced.writes().map(({ key }) => key)).toEqual(["POST /git/refs"]);
  });

  it("reports an unresolved create without exposing the provider body or retrying the POST", async () => {
    const { transport, replies, writes } = fixture();
    replies.set("GET " + headPath, () => new Response(null, { status: 404 }));
    replies.set("POST /git/refs", () => new Response("private provider body", { status: 503 }));
    const result = transport.ensureHeadRef({ head });
    await expect(result).rejects.toMatchObject({ code: "ref_creation_uncertain" });
    await expect(result).rejects.not.toThrow("private provider body");
    expect(writes()).toHaveLength(1);
  });

  it("verifies the exact head ref, baseline parent and candidate file bytes", async () => {
    const { transport, writes } = fixture();
    await expect(transport.verifyHead(verifyCommand)).resolves.toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it("can verify a retained immutable commit after the terminal PR branch disappears", async () => {
    const { transport, replies } = fixture();
    replies.set("GET " + headPath, () => new Response(null, { status: 404 }));
    await expect(transport.verifyHead(verifyCommand)).rejects.toMatchObject({
      code: "head_conflict",
    });
    await expect(
      transport.verifyHead({ ...verifyCommand, requireRef: false }),
    ).resolves.toBeUndefined();
    replies.set("GET " + headPath, gitRef(target.headBranch, "e".repeat(40)));
    await expect(
      transport.verifyHead({ ...verifyCommand, requireRef: false }),
    ).rejects.toMatchObject({
      code: "head_conflict",
    });
  });

  it("rejects an extra file change in a nested configuration directory", async () => {
    const { transport, replies, newDefinitions, nextFile } = fixture();
    replies.set("GET /git/trees/" + newDefinitions, {
      sha: newDefinitions,
      truncated: false,
      tree: [nextFile, file("shared.json", "9".repeat(40), 30)],
    });
    await expect(transport.verifyHead(verifyCommand)).rejects.toMatchObject({
      code: "head_conflict",
    });
  });

  it("refuses a head with a second parent or changed file bytes", async () => {
    const mergedHead = fixture();
    mergedHead.replies.set("GET /git/commits/" + head.commitSha, {
      sha: head.commitSha,
      tree: { sha: head.treeSha },
      parents: [{ sha: base.commitSha }, { sha: "e".repeat(40) }],
    });
    await expect(mergedHead.transport.verifyHead(verifyCommand)).rejects.toMatchObject({
      code: "head_conflict",
    });
    await expect(
      fixture().transport.verifyHead({ ...verifyCommand, candidateDigest: "9".repeat(64) }),
    ).rejects.toMatchObject({ code: "head_conflict" });
  });

  it("verifies the hosted PR’s exact branches, repository IDs and frozen commits including a terminal PR", async () => {
    const { transport, replies } = fixture();
    await expect(verify(transport)).resolves.toMatchObject({
      number: pullNumber,
      url: pullUrl,
      state: "open",
      headSha: head.commitSha,
    });
    const original = hostedPullRequest();
    replies.set("GET /pulls/" + pullNumber, { ...original, state: "closed", draft: false });
    await expect(verify(transport)).resolves.toMatchObject({
      state: "closed",
      headSha: head.commitSha,
    });
    const mergedAt = "2026-11-22T07:00:59Z";
    const mergeCommitSha = "9".repeat(40);
    replies.set("GET /pulls/" + pullNumber, {
      ...original,
      state: "closed",
      draft: false,
      merged_at: mergedAt,
      merged: true,
      merge_commit_sha: mergeCommitSha,
    });
    await expect(verify(transport)).resolves.toMatchObject({
      state: "merged",
      merge: { mergedAt, mergeCommitSha, sourceHeadSha: head.commitSha },
    });
  });

  it.each([
    { ...hostedPullRequest(), base: { ...hostedPullRequest().base, sha: "a".repeat(39) + "b" } },
    {
      ...hostedPullRequest(),
      head: { ...hostedPullRequest().head, repo: { ...repository, id: 99 } },
    },
    { ...hostedPullRequest(), base: { ...hostedPullRequest().base, ref: "main" } },
    { ...hostedPullRequest(), html_url: "https://elsewhere.test/fixture/definitions/pull/42" },
  ])("refuses an unrelated, retargeted or spoofed provider pull request", async (pull) => {
    const { transport, replies } = fixture();
    replies.set("GET /pulls/" + pullNumber, pull);
    await expect(verify(transport)).rejects.toMatchObject({ code: "pull_request_conflict" });
  });

  it("rejects larger-than-allowed provider responses and does not follow redirects", async () => {
    const oversized = fixture();
    oversized.replies.set(
      "GET ",
      new Response("oversized", { headers: { "content-length": "10000000" } }),
    );
    await expect(oversized.transport.readBase()).rejects.toMatchObject({
      code: "invalid_response",
    });
    const redirected = fixture();
    redirected.replies.set("GET ", Response.redirect("https://elsewhere.test"));
    await expect(redirected.transport.readBase()).rejects.toMatchObject({
      code: "remote_unavailable",
      status: 302,
    });
    expect(redirected.calls.map(({ key }) => key)).toEqual(["GET "]);
  });

  it("preserves the caller’s abort reason even if the fetcher ignores the abort signal", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const transport = createImprovementPublicationGitHub({ target, token, fetcher });
    const result = transport.readBase(controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  it("bounds a stalled provider request without throwing a provider error object", async () => {
    const lifetime = new AbortController();
    const request = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 10_000 ? request.signal : lifetime.signal,
    );
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const transport = createImprovementPublicationGitHub({ target, token, fetcher });
    const result = transport.readBase();
    expect(fetcher).toHaveBeenCalledTimes(1);
    request.abort(new Error("private timeout details"));
    await expect(result).rejects.toMatchObject({ code: "remote_unavailable" });
    await expect(result).rejects.not.toThrow("private timeout details");
  });
});
