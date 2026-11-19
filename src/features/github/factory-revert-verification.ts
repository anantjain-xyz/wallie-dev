import "server-only";

import { z } from "zod/v4";

import {
  type FactoryRevertTarget,
  githubRevertRepositoryNameSchema,
} from "@/lib/factory-outcomes/revert-contracts";
import { readCanonicalGitHubJson, readCanonicalGitHubMerge } from "@/lib/pipeline/canonical-pr-api";

import { mintPrVerificationToken } from "./pr-verification-auth";

const githubPullRequestIdentitySchema = z.object({
  number: z.number().int().positive().max(2_147_483_647),
  html_url: z.url(),
  merged: z.literal(true),
  updated_at: z.iso.datetime({ offset: true }),
  base: z.object({
    ref: z.string().min(1),
    repo: z.object({
      id: z.number().int().positive(),
      full_name: githubRevertRepositoryNameSchema,
    }),
  }),
});

export async function verifyFactoryRevertPullRequest({
  target,
  revertPrNumber,
  signal: requestSignal,
}: {
  target: FactoryRevertTarget;
  revertPrNumber: number;
  signal: AbortSignal;
}) {
  const unverified = { ok: false, code: "unverified" } as const;
  const unavailable = { ok: false, code: "unavailable" } as const;
  if (revertPrNumber === target.pullRequestNumber) return unverified;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);

  let payload: unknown;
  try {
    signal.throwIfAborted();
    const { token } = await mintPrVerificationToken({
      repositoryNumericId: target.repositoryNumericId,
      installationId: target.installationId,
      signal,
    });
    const response = await fetch(
      `https://api.github.com/repos/${target.repositoryFullName}/pulls/${revertPrNumber}`,
      {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Wallie",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return unavailable;
    }
    payload = await readCanonicalGitHubJson(response, signal);
  } catch {
    return unavailable;
  }

  const parsed = githubPullRequestIdentitySchema.safeParse(payload);
  if (!parsed.success) return unverified;
  const pr = parsed.data;
  const url = new URL(pr.html_url);
  if (
    pr.number !== revertPrNumber ||
    pr.base.ref !== target.baseBranch ||
    pr.base.repo.id !== target.repositoryNumericId ||
    pr.base.repo.full_name.toLowerCase() !== target.repositoryFullName.toLowerCase() ||
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !==
      `/${target.repositoryFullName}/pull/${revertPrNumber}`.toLowerCase()
  ) {
    return unverified;
  }

  const merge = readCanonicalGitHubMerge(payload);
  if (
    !merge ||
    merge.mergeCommitSha === target.mergeCommitSha ||
    Date.parse(merge.mergedAt) <= Date.parse(target.mergedAt) ||
    Date.parse(pr.updated_at) > Date.now()
  ) {
    return unverified;
  }
  return {
    ok: true,
    proof: {
      repositoryNumericId: pr.base.repo.id,
      baseBranch: pr.base.ref,
      pullRequestNumber: pr.number,
      mergeCommitSha: merge.mergeCommitSha,
      mergedAt: merge.mergedAt,
      updatedAt: pr.updated_at,
    },
  } as const;
}
