import { beforeEach, expect, it, vi } from "vitest";

import {
  createGitHubResourceReader,
  GitHubAccessError,
  GitHubResourceBoundsError,
} from "@/lib/factory-context/github-source";

import { readFactoryJudgeCodeDiff } from "./exact-diff";

vi.mock("@/lib/factory-context/github-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factory-context/github-source")>()),
  createGitHubResourceReader: vi.fn(),
}));

const source = {
  installationId: 1,
  repositoryId: 25,
  repositoryFullName: "acme/fixture",
  inputSha: "a".repeat(40),
  outputSha: "b".repeat(40),
};
const file = {
  filename: "src/fixture.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
};
const response = {
  status: "ahead",
  base_commit: { sha: source.inputSha },
  merge_base_commit: { sha: source.inputSha },
  total_commits: 1,
  commits: [{ sha: source.outputSha }],
  files: [file],
};

beforeEach(() => vi.resetAllMocks());

it("reads the exact checkout comparison with a bounded, repository-scoped request", async () => {
  const read = vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(response)));
  vi.mocked(createGitHubResourceReader).mockResolvedValue(read);

  const result = await readFactoryJudgeCodeDiff(source, new AbortController().signal);
  expect(result).toEqual({
    status: "available",
    text: 'modified "src/fixture.ts"\n@@ -1 +1 @@\n-old\n+new',
  });
  expect(createGitHubResourceReader).toHaveBeenCalledWith(source, expect.any(AbortSignal));
  expect(read).toHaveBeenCalledExactlyOnceWith(
    `compare/${source.inputSha}...${source.outputSha}`,
    512 * 1024,
  );
});

it("treats the same exact commit as an empty diff without calling GitHub", async () => {
  const result = await readFactoryJudgeCodeDiff(
    { ...source, outputSha: source.inputSha },
    new AbortController().signal,
  );
  expect(result).toEqual({ status: "available", text: "" });
  expect(createGitHubResourceReader).not.toHaveBeenCalled();
});

it.each([
  { merge_base_commit: { sha: "c".repeat(40) } },
  { commits: [{ sha: "c".repeat(40) }] },
  { total_commits: 2 },
  { files: [{ ...file, additions: 2 }] },
  { files: [{ ...file, patch: undefined }] },
  {
    files: [
      {
        ...file,
        status: "renamed",
        previous_filename: "old.gif",
        filename: "new.gif",
        additions: 0,
        deletions: 0,
        patch: undefined,
      },
    ],
  },
])("rejects an incomplete or wrong-commit comparison", async (override) => {
  vi.mocked(createGitHubResourceReader).mockResolvedValue(
    vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ ...response, ...override }))),
  );

  await expect(readFactoryJudgeCodeDiff(source, new AbortController().signal)).resolves.toEqual({
    status: "unsupported",
  });
});

it.each([
  [new GitHubAccessError(), "missing"],
  [new GitHubResourceBoundsError(), "unsupported"],
  [new Error("Connection reset"), "unavailable"],
] as const)("classifies comparison transport failures", async (error, status) => {
  vi.mocked(createGitHubResourceReader).mockRejectedValue(error);
  await expect(readFactoryJudgeCodeDiff(source, new AbortController().signal)).resolves.toEqual({
    status,
  });
});
