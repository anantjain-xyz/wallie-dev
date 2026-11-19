import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";

import { fetchGitHubContextFile } from "./github-source";

vi.mock("@/features/github/sandbox-token", () => ({
  mintSandboxRepositoryToken: vi.fn(),
}));

const mintToken = vi.mocked(mintSandboxRepositoryToken);
const fetchMock = vi.fn<typeof fetch>();
const input = {
  installationId: 21,
  repositoryId: 42,
  repositoryFullName: "org/repo",
  filePath: "docs/Design note.MD",
};
const api = "https://api.github.com/repositories/42";
const head = "a".repeat(40);
const rootTree = "b".repeat(40);
const docsTree = "c".repeat(40);
const upstreamDate = "2026-11-19T11:12:13-05:00";
const metadata = {
  sha: head,
  committer: { date: upstreamDate },
  tree: { sha: rootTree },
};
const docsEntry = { path: "docs", type: "tree", mode: "040000", sha: docsTree };

function treeResponse(id: string, entries: unknown[], truncated = false) {
  return Response.json({ sha: id, truncated, tree: entries });
}

function regularFileEntry(bytes: Uint8Array) {
  return {
    path: "Design note.MD",
    type: "blob",
    mode: "100644",
    size: bytes.byteLength,
    sha: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
  };
}

function mockDirectory() {
  fetchMock
    .mockResolvedValueOnce(new Response(`${head}\n`))
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(treeResponse(rootTree, [docsEntry]));
}

describe("GitHub context source sync", () => {
  beforeEach(() => {
    mintToken.mockReset().mockResolvedValue("read-context-token");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns exact text and canonical Git provenance through one scoped read credential", async () => {
    const content =
      "\uFEFF# Engineering notes\nKeep the literal template marker {{stage.prompt}}.\n";
    const entry = regularFileEntry(Buffer.from(content));
    mockDirectory();
    fetchMock
      .mockResolvedValueOnce(treeResponse(docsTree, [entry]))
      .mockResolvedValueOnce(new Response(content));

    await expect(fetchGitHubContextFile(input)).resolves.toEqual({
      status: "synced",
      content,
      upstreamRevision: head,
      upstreamUpdatedAt: "2026-11-19T16:12:13.000Z",
    });
    expect(mintToken).toHaveBeenCalledExactlyOnceWith({
      installationId: 21,
      repositoryId: 42,
      repositoryFullName: "org/repo",
      purpose: "read-context",
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${api}/commits/HEAD`,
      `${api}/git/commits/${head}`,
      `${api}/git/trees/${rootTree}`,
      `${api}/git/trees/${docsTree}`,
      `${api}/git/blobs/${entry.sha}`,
    ]);
    const issued = mintToken.mock.calls[0]?.[0];
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({
        cache: "no-store",
        redirect: "error",
        signal: issued?.signal,
        headers: { Authorization: "Bearer read-context-token" },
      });
    }
  });

  it("supports an empty text document", async () => {
    const entry = regularFileEntry(new Uint8Array());
    mockDirectory();
    fetchMock
      .mockResolvedValueOnce(treeResponse(docsTree, [entry]))
      .mockResolvedValueOnce(new Response(""));
    await expect(fetchGitHubContextFile(input)).resolves.toMatchObject({
      status: "synced",
      content: "",
    });
  });

  it("reports deletion only after reading a complete exact tree", async () => {
    mockDirectory();
    fetchMock.mockResolvedValueOnce(treeResponse(docsTree, []));
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "upstream_deleted" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports the child absent when its parent path became a file", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(head))
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(
        treeResponse(rootTree, [
          { path: "docs", type: "blob", mode: "100644", size: 1, sha: "e".repeat(40) },
        ]),
      );
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "upstream_deleted" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [404, {}, "unavailable"],
    [429, {}, "unavailable"],
    [403, { "x-ratelimit-remaining": "0" }, "unavailable"],
    [403, { "retry-after": "120" }, "unavailable"],
    [401, {}, "access_revoked"],
    [403, {}, "access_revoked"],
    [503, {}, "unavailable"],
  ] as const)("maps provider HTTP %s without exposing the body", async (status, headers, state) => {
    mockDirectory();
    fetchMock.mockResolvedValueOnce(new Response("private provider message", { status, headers }));
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: state });
  });

  it("keeps a secondary rate limit retryable even without retry headers", async () => {
    mockDirectory();
    fetchMock.mockResolvedValueOnce(
      Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
    );
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "unavailable" });
  });

  it.each([
    treeResponse(rootTree, []),
    treeResponse(docsTree, [], true),
    treeResponse(docsTree, [
      { path: "Design note.MD", type: "blob", mode: "120000", size: 8, sha: "e".repeat(40) },
    ]),
    treeResponse(docsTree, [{ ...regularFileEntry(Buffer.from("small")), size: 128 * 1024 + 1 }]),
  ])("rejects wrong, truncated, symlink-bearing, or oversized tree entries", async (response) => {
    mockDirectory();
    fetchMock.mockResolvedValueOnce(response);
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a commit response that does not match the observed HEAD", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(head))
      .mockResolvedValueOnce(Response.json({ ...metadata, sha: "d".repeat(40) }));
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["../note.md", "note.exe", "/note.md", "docs//note.md"])(
    "rejects a noncanonical or unsupported path before contacting GitHub",
    async (filePath) => {
      await expect(fetchGitHubContextFile({ ...input, filePath })).resolves.toEqual({
        status: "unavailable",
      });
      expect(mintToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [Uint8Array.of(195, 40), Uint8Array.of(195, 40)],
    [Uint8Array.of(0), Uint8Array.of(0)],
    [Uint8Array.of(65), Uint8Array.of(66)],
    [Uint8Array.of(65), new Uint8Array()],
  ])(
    "rejects invalid UTF-8, NUL, and bytes that do not match the Git blob",
    async (expected, body) => {
      mockDirectory();
      fetchMock
        .mockResolvedValueOnce(treeResponse(docsTree, [regularFileEntry(expected)]))
        .mockResolvedValueOnce(new Response(body));
      await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "unavailable" });
    },
  );

  it("cancels a streamed blob that exceeds its declared Git tree length", async () => {
    const expected = Uint8Array.of(65);
    const cancel = vi.fn();
    mockDirectory();
    fetchMock
      .mockResolvedValueOnce(treeResponse(docsTree, [regularFileEntry(expected)]))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.of(65, 66));
            },
            cancel,
          }),
        ),
      );

    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps token denial without returning provider error text or making a follow-on request", async () => {
    mintToken.mockRejectedValueOnce(
      Object.assign(new Error("private credentials"), { status: 401 }),
    );
    await expect(fetchGitHubContextFile(input)).resolves.toEqual({ status: "access_revoked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a shared deadline even when token minting does not finish", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const token = Promise.withResolvers<string>();
    mintToken.mockReturnValueOnce(token.promise);
    const syncing = fetchGitHubContextFile(input);

    controller.abort();
    await expect(syncing).resolves.toEqual({ status: "unavailable" });
    token.resolve("late-token");
    await token.promise;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
