import { afterEach, expect, it, vi } from "vitest";

import { CanonicalPrApiError, createCanonicalPrApi } from "./canonical-pr-api";

const sha = "a".repeat(40);
const repository = { id: 777, full_name: "acme/app" };
const branch = "wallie/sessions/session/epoch-1";
type ProviderPr = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string; repo: typeof repository | null };
  base: { ref: string; repo: typeof repository | null };
};
function pr(overrides: Partial<ProviderPr> = {}): ProviderPr {
  return {
    number: 42,
    html_url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    merged_at: null,
    updated_at: "2026-11-05T12:00:00Z",
    head: { ref: branch, sha, repo: { ...repository } },
    base: { ref: "main", repo: { ...repository } },
    ...overrides,
  };
}
function setup(replies: Array<unknown | Response | Error> = []) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (!replies.length) throw new Error("Unexpected request");
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : Response.json(reply);
  });
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const input = {
    repositoryFullName: "acme/app",
    repositoryNumericId: 777,
    branchName: branch,
    baseBranch: "main",
    token: "private-repository-token",
    signal: controller.signal,
  };
  return { api: createCanonicalPrApi(input), input, fetch, controller };
}
function validationError(error: Record<string, unknown>) {
  return Response.json({ message: "Validation Failed", errors: [error] }, { status: 422 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  { state: "open" as const, merged_at: null, expected: "open" },
  { state: "closed" as const, merged_at: null, expected: "closed" },
  { state: "closed" as const, merged_at: "2026-11-05T11:00:00Z", expected: "merged" },
])(
  "finds the existing $expected PR across all states without filtering by head SHA",
  async (state) => {
    const olderSha = "b".repeat(40);
    const { api, fetch } = setup([
      [
        pr({
          state: state.state,
          merged_at: state.merged_at,
          head: { ref: branch, sha: olderSha, repo: repository },
        }),
      ],
    ]);
    expect(await api.find()).toEqual({
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      state: state.expected,
      draft: false,
      headSha: olderSha,
      updatedAt: "2026-11-05T12:00:00Z",
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("head")).toBe(`acme:${branch}`);
    expect(url.searchParams.get("state")).toBe("all");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  },
);

it("ignores another branch and same-named external fork heads", async () => {
  const { api } = setup([
    [
      pr({ head: { ref: "another-branch", sha, repo: repository } }),
      pr({ head: { ref: branch, sha, repo: { id: 999, full_name: "fork-owner/app" } } }),
    ],
  ]);
  expect(await api.find()).toBeNull();
});

it.each(["open", "closed"] as const)(
  "does not treat a %s PR with deleted head identity as absence",
  async (state) => {
    const { api, fetch } = setup([[pr({ state, head: { ref: branch, sha, repo: null } })]]);
    await expect(api.find()).rejects.toMatchObject({ code: "pr_identity_conflict" });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  { mergedAt: null, expected: "closed" },
  { mergedAt: "2026-11-05T11:00:00Z", expected: "merged" },
])(
  "preserves pinned $expected state after GitHub deletes its head repository identity",
  async ({ mergedAt, expected }) => {
    const { api } = setup([
      pr({
        state: "closed",
        merged_at: mergedAt,
        head: { ref: branch, sha, repo: null },
      }),
    ]);
    expect(await api.get(42)).toMatchObject({ number: 42, state: expected, headSha: sha });
  },
);

it.each([
  { head: { ref: "changed-branch", sha, repo: null } },
  { base: { ref: "changed-base", repo: repository } },
  { base: { ref: "main", repo: { id: 888, full_name: "acme/app" } } },
])(
  "does not relax other pinned identity checks for terminal deleted-head snapshots (%j)",
  async (identity) => {
    const { api } = setup([
      pr({
        state: "closed",
        head: { ref: branch, sha, repo: null },
        ...identity,
      }),
    ]);
    await expect(api.get(42)).rejects.toMatchObject({ code: "pr_identity_conflict" });
  },
);

it("matches repository names case-insensitively while requiring the numeric identity", async () => {
  const { api } = setup([
    [
      pr({
        head: { ref: branch, sha, repo: { id: 777, full_name: "Acme/App" } },
        base: { ref: "main", repo: { id: 777, full_name: "ACME/APP" } },
      }),
    ],
  ]);
  expect((await api.find())?.number).toBe(42);
});

it("checks every page after a full page rather than declaring a matching PR absent", async () => {
  const unrelated = Array.from({ length: 100 }, (_, index) =>
    pr({
      number: index + 100,
      head: { ref: `other-${index}`, sha, repo: repository },
    }),
  );
  const { api, fetch } = setup([unrelated, [pr()]]);
  expect((await api.find())?.number).toBe(42);
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("page"))).toEqual([
    "1",
    "2",
  ]);
  expect(
    fetch.mock.calls.every(
      ([url, options]) =>
        String(url).startsWith("https://api.github.com/repos/acme/app/pulls?") &&
        options?.method === "GET" &&
        options.redirect === "manual",
    ),
  ).toBe(true);
});

it("continues a short linked page using its own API origin instead of following arbitrary link URLs", async () => {
  const first = Response.json([], {
    headers: { Link: '<https://untrusted.invalid/page>; rel="next"' },
  });
  const { api, fetch } = setup([first, [pr()]]);
  expect((await api.find())?.number).toBe(42);
  expect(new URL(String(fetch.mock.calls[1][0])).origin).toBe("https://api.github.com");
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("page")).toBe("2");
});

it("rejects multiple matching PR identities including terminal matches on later pages", async () => {
  const first = Response.json([pr()], {
    headers: { Link: '<https://api.github.com/next>; rel="next"' },
  });
  const { api, fetch } = setup([
    first,
    [pr({ number: 43, html_url: "https://github.com/acme/app/pull/43", state: "closed" })],
  ]);
  await expect(api.find()).rejects.toMatchObject({
    code: "pr_multiple_matches",
    retryCreationSafe: false,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});

it("fails closed at the pagination bound rather than returning a false absence", async () => {
  const { api, fetch } = setup();
  const page = Array.from({ length: 100 }, (_, index) =>
    pr({ head: { ref: `other-${index}`, sha, repo: repository } }),
  );
  fetch.mockImplementation(async () => Response.json(page));
  await expect(api.find()).rejects.toMatchObject({
    code: "pr_pagination_limit",
    retryCreationSafe: false,
  });
  expect(fetch).toHaveBeenCalledTimes(20);
});

it.each([
  { head: { ref: branch, sha, repo: { id: 888, full_name: "acme/app" } } },
  { head: { ref: branch, sha, repo: { id: 777, full_name: "renamed/app" } } },
  { base: { ref: "main", repo: { id: 888, full_name: "acme/app" } } },
  { base: { ref: "main", repo: { id: 777, full_name: "renamed/app" } } },
  { base: { ref: "changed-base", repo: repository } },
])("refuses find identity drift instead of opening a replacement (%j)", async (identity) => {
  const { api, fetch } = setup([[pr(identity)]]);
  await expect(api.find()).rejects.toMatchObject({ code: "pr_identity_conflict" });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { head: { ref: "changed-branch", sha, repo: repository } },
  { head: { ref: branch, sha, repo: null } },
  { head: { ref: branch, sha, repo: { id: 888, full_name: "acme/app" } } },
  { head: { ref: branch, sha, repo: { id: 777, full_name: "renamed/app" } } },
  { base: { ref: "changed-base", repo: repository } },
  { base: { ref: "main", repo: { id: 888, full_name: "acme/app" } } },
  { number: 43 },
])("rejects changed identity for a pinned PR number (%j)", async (identity) => {
  const { api, fetch } = setup([pr(identity)]);
  await expect(api.get(42)).rejects.toMatchObject({
    code: "pr_identity_conflict",
    retryCreationSafe: false,
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/acme/app/pulls/42",
    expect.objectContaining({ method: "GET", redirect: "manual" }),
  );
});

it("keeps a missing pinned number as an error without searching or creating a replacement", async () => {
  const { api, fetch } = setup([Response.json({ message: "Not Found" }, { status: 404 })]);
  await expect(api.get(42)).rejects.toMatchObject({
    code: "pr_api_failed",
    status: 404,
    retryCreationSafe: false,
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toBe("https://api.github.com/repos/acme/app/pulls/42");
});

it("creates only the requested canonical head/base and validates the returned receipt", async () => {
  const { api, fetch } = setup([Response.json(pr({ draft: true }), { status: 201 })]);
  expect(
    await api.create({ title: "Implement session", body: "Accepted durable output" }),
  ).toMatchObject({ number: 42, draft: true, headSha: sha });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/acme/app/pulls",
    expect.objectContaining({
      method: "POST",
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: "Bearer private-repository-token" }),
      body: JSON.stringify({
        base: "main",
        head: branch,
        title: "Implement session",
        body: "Accepted durable output",
      }),
    }),
  );
});

it("reconciles a created PR after losing its POST response without automatically sending another POST", async () => {
  const { api, fetch } = setup();
  let saved: ProviderPr | null = null;
  fetch.mockImplementation(async (_url, options) => {
    if (options?.method === "POST") {
      saved = pr();
      throw new Error(
        "Network error containing private-repository-token and private artifact text",
      );
    }
    return Response.json(saved ? [saved] : []);
  });
  const outcome = await api
    .create({ title: "Build", body: "Private artifact" })
    .catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(CanonicalPrApiError);
  expect(outcome).toMatchObject({ code: "pr_creation_uncertain", retryCreationSafe: false });
  expect(JSON.stringify(outcome)).not.toContain("private-repository-token");
  expect(String(outcome)).not.toContain("private artifact");
  expect((await api.find())?.number).toBe(42);
  expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});

it.each([401, 403, 404])(
  "classifies a definitive POST %s rejection as safe for a later retry",
  async (status) => {
    const { api } = setup([Response.json({ message: "private-repository-token" }, { status })]);
    await expect(api.create({ title: "Build", body: "Done" })).rejects.toMatchObject({
      code: "pr_creation_rejected",
      status,
      retryCreationSafe: true,
    });
  },
);

it("allows an explicit later creation after a permission rejection and fresh all-state reconciliation", async () => {
  const { api, fetch } = setup([
    Response.json({ message: "Forbidden" }, { status: 403 }),
    [],
    Response.json(pr(), { status: 201 }),
  ]);
  await expect(api.create({ title: "Build", body: "Done" })).rejects.toMatchObject({
    retryCreationSafe: true,
  });
  expect(await api.find()).toBeNull();
  expect((await api.create({ title: "Build", body: "Done" })).number).toBe(42);
  expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET", "POST"]);
});

it.each([
  { resource: "PullRequest", code: "invalid", field: "head" },
  { resource: "PullRequest", code: "missing_field", field: "title" },
  { resource: "PullRequest", code: "custom", message: `No commits between main and ${branch}` },
])("classifies recognized non-duplicate 422 validation as definitive (%j)", async (error) => {
  const { api } = setup([validationError(error)]);
  await expect(api.create({ title: "Build", body: "Done" })).rejects.toMatchObject({
    code: "pr_creation_rejected",
    status: 422,
    retryCreationSafe: true,
  });
});

it.each([
  { resource: "PullRequest", code: "already_exists", field: "head" },
  {
    resource: "PullRequest",
    code: "custom",
    message: "A pull request already exists for acme:branch.",
  },
  { resource: "PullRequest", code: "invalid", field: "head", message: "Duplicate pull request" },
  { resource: "PullRequest", code: "custom", message: "Unrecognized provider validation" },
])("leaves duplicate or unrecognized 422 outcomes armed for reconciliation (%j)", async (error) => {
  const { api } = setup([validationError(error)]);
  await expect(api.create({ title: "Build", body: "Done" })).rejects.toMatchObject({
    code: "pr_creation_uncertain",
    status: 422,
    retryCreationSafe: false,
  });
});

it.each([301, 307, 429, 500, 503])(
  "keeps POST status %s uncertain and never follows redirects",
  async (status) => {
    const { api, fetch } = setup([
      Response.json(
        { message: "private error" },
        { status, headers: { Location: "https://untrusted.invalid" } },
      ),
    ]);
    await expect(api.create({ title: "Build", body: "Done" })).rejects.toMatchObject({
      code: "pr_creation_uncertain",
      status,
      retryCreationSafe: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  },
);

it.each([
  { ...pr(), head: { ref: branch, sha: "invalid", repo: repository } },
  { ...pr(), updated_at: "not a timestamp" },
  { ...pr(), draft: "false" },
  { ...pr(), base: null },
  { ...pr(), html_url: "https://untrusted.invalid/acme/app/pull/42" },
  { ...pr(), state: "open", merged_at: "2026-11-05T11:00:00Z" },
])("rejects malformed GET receipts without returning false success (%j)", async (value) => {
  const { api } = setup([value]);
  await expect(api.get(42)).rejects.toMatchObject({
    code: "pr_invalid_response",
    retryCreationSafe: false,
  });
});

it("does not treat a malformed list page as proof that no canonical PR exists", async () => {
  const { api } = setup([[{ number: "private payload" }]]);
  await expect(api.find()).rejects.toMatchObject({ code: "pr_invalid_response" });
});

it.each([
  Response.json({ number: 42 }, { status: 201 }),
  new Response("not JSON containing private-repository-token", { status: 201 }),
  Response.json(pr({ head: { ref: "wrong-branch", sha, repo: repository } }), { status: 201 }),
])("keeps a malformed or changed successful creation response uncertain", async (response) => {
  const { api } = setup([response]);
  const error = await api.create({ title: "Build", body: "Done" }).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "pr_creation_uncertain", retryCreationSafe: false });
  expect(String(error)).not.toContain("private-repository-token");
});

it("bounds declared and streamed response sizes", async () => {
  const { api } = setup([
    new Response("{}", { headers: { "Content-Length": String(8 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
  ]);
  await expect(api.get(42)).rejects.toMatchObject({ code: "pr_invalid_response" });
  await expect(api.get(42)).rejects.toMatchObject({ code: "pr_invalid_response" });
});

it("bounds an unresponsive POST transport and ignores a late creation receipt", async () => {
  vi.useFakeTimers();
  const { api, fetch } = setup();
  let resolve!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((complete) => {
        resolve = complete;
      }),
  );
  const outcome = api.create({ title: "Build", body: "Done" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toMatchObject({ code: "pr_creation_uncertain", retryCreationSafe: false });
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  resolve(Response.json(pr(), { status: 201 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
});

it("bounds a creation response body that never finishes", async () => {
  vi.useFakeTimers();
  const { api } = setup([new Response(new ReadableStream<Uint8Array>(), { status: 201 })]);
  const outcome = api.create({ title: "Build", body: "Done" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toMatchObject({ code: "pr_creation_uncertain", retryCreationSafe: false });
});

it("rejects an already-aborted creation before fetching and sanitizes its reason", async () => {
  const { api, fetch, controller } = setup();
  controller.abort(new Error("private-repository-token"));
  const error = await api.create({ title: "Build", body: "Done" }).catch((error: unknown) => error);
  expect(error).toMatchObject({ retryCreationSafe: true });
  expect(String(error)).not.toContain("private-repository-token");
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects invalid configuration and local creation payloads before network mutation", async () => {
  const { api, input, fetch } = setup();
  expect(() => createCanonicalPrApi({ ...input, repositoryFullName: "../app" })).toThrow(
    CanonicalPrApiError,
  );
  expect(() => createCanonicalPrApi({ ...input, branchName: "wallie/../unsafe" })).toThrow(
    CanonicalPrApiError,
  );
  await expect(api.create({ title: "", body: "Done" })).rejects.toMatchObject({
    code: "pr_creation_rejected",
    retryCreationSafe: true,
  });
  await expect(api.get(-1)).rejects.toMatchObject({ code: "pr_invalid_input" });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not authorize clearing a previous creation arm when factory configuration is invalid", () => {
  const { input, fetch } = setup();
  let outcome: unknown;
  try {
    createCanonicalPrApi({ ...input, token: "invalid token" });
  } catch (error) {
    outcome = error;
  }
  expect(outcome).toMatchObject({ code: "pr_invalid_input", retryCreationSafe: false });
  expect(fetch).not.toHaveBeenCalled();
});
