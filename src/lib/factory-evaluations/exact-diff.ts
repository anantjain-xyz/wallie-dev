import "server-only";

import { z } from "zod/v4";

import {
  createGitHubResourceReader,
  GitHubAccessError,
  GitHubResourceBoundsError,
} from "@/lib/factory-context/github-source";

const maxCommits = 64;
const maxFiles = 100;
const maxComparisonBytes = 512 * 1024;
const maxDiffBytes = 64 * 1024;
const objectId = z.string().regex(/^[0-9a-f]{40}$/);
const commit = z.object({ sha: objectId });
const comparisonFile = z.object({
  filename: z.string().min(1).max(4096),
  previous_filename: z.string().min(1).max(4096).optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const comparison = z.object({
  status: z.literal("ahead"),
  base_commit: commit,
  merge_base_commit: commit,
  total_commits: z.number().int().min(1).max(maxCommits),
  commits: z.array(commit).min(1).max(maxCommits),
  files: z.array(comparisonFile).max(maxFiles),
});

type Source = Parameters<typeof createGitHubResourceReader>[0] & {
  inputSha: string;
  outputSha: string;
};

function hasCompletePatch(file: z.output<typeof comparisonFile>) {
  if (!file.patch) return false;
  let additions = 0;
  let deletions = 0;
  for (const line of file.patch.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return additions === file.additions && deletions === file.deletions;
}

/** Read a bounded textual comparison of the accepted checkpoint's exact commits. */
export async function readFactoryJudgeCodeDiff(
  source: Source,
  signal: AbortSignal,
): Promise<
  { status: "available"; text: string } | { status: "missing" | "unsupported" | "unavailable" }
> {
  const { inputSha, outputSha } = source;
  if (!objectId.safeParse(inputSha).success || !objectId.safeParse(outputSha).success) {
    return { status: "unsupported" };
  }
  if (inputSha === outputSha) return { status: "available", text: "" };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  try {
    const read = await createGitHubResourceReader(source, deadline);
    const bytes = await read(`compare/${inputSha}...${outputSha}`, maxComparisonBytes);
    const parsed = comparison.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
    );
    if (!parsed.success) return { status: "unsupported" };
    const { base_commit, merge_base_commit, commits, total_commits, files } = parsed.data;
    if (
      base_commit.sha !== inputSha ||
      merge_base_commit.sha !== inputSha ||
      commits.length !== total_commits ||
      commits.at(-1)?.sha !== outputSha ||
      files.some((file) => !hasCompletePatch(file))
    ) {
      return { status: "unsupported" };
    }
    const text = files
      .map((file) => {
        const before = file.previous_filename
          ? ` from ${JSON.stringify(file.previous_filename)}`
          : "";
        return `${file.status} ${JSON.stringify(file.filename)}${before}\n${file.patch ?? ""}`;
      })
      .join("\n\n");
    if (Buffer.byteLength(text, "utf8") > maxDiffBytes) return { status: "unsupported" };
    return { status: "available", text };
  } catch (error) {
    if (error instanceof GitHubAccessError) return { status: "missing" };
    if (error instanceof GitHubResourceBoundsError) return { status: "unsupported" };
    return { status: "unavailable" };
  }
}
