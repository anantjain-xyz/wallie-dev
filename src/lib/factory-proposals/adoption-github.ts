import "server-only";

import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  factoryImprovementReviewProofSchema,
  type FactoryImprovementReviewProof,
} from "./adoption-contracts";
import type { FactoryImprovementPublication } from "./publication-contracts";
import {
  createImprovementAdoptionGitHub,
  ImprovementPublicationGitHubError,
} from "./publication-github";

type ReviewPublication = Pick<
  FactoryImprovementPublication,
  | "target"
  | "pullRequest"
  | "base"
  | "candidate"
  | "baseCommitSha"
  | "baseTreeSha"
  | "headCommitSha"
  | "headTreeSha"
>;

export class ImprovementAdoptionGitHubError extends Error {
  constructor(readonly code: "review_conflict" | "remote_unavailable") {
    super("The factory improvement GitHub review could not be verified.");
    this.name = "ImprovementAdoptionGitHubError";
  }
}

const proofTimeoutMs = 30_000;
const reviewsPerPage = 100;
const reviewPageLimit = 5;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positiveId = z.number().int().positive().safe();
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const login = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i);
const actor = z.object({ id: positiveId, login: z.string(), type: z.string() });
const decisiveReview = z.object({
  id: positiveId,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  user: actor.nullable(),
  commit_id: sha,
  submitted_at: timestamp,
});
const reviewPage = z
  .array(
    z.discriminatedUnion("state", [
      decisiveReview,
      z.object({ id: positiveId, state: z.enum(["COMMENTED", "PENDING"]) }),
    ]),
  )
  .max(reviewsPerPage);
const reviewerPermission = z.object({
  permission: z.enum(["none", "read", "write", "admin"]),
  user: actor,
});

type DecisiveReview = z.output<typeof decisiveReview> & { user: z.output<typeof actor> };
type GitHub = ReturnType<typeof createImprovementAdoptionGitHub>;
type MergedPull = Awaited<ReturnType<GitHub["verifyMergedPullRequest"]>>;

function reviewConflict(): never {
  throw new ImprovementAdoptionGitHubError("review_conflict");
}

function observedTime(value: string) {
  const parsed = timestamp.safeParse(value);
  if (!parsed.success) return reviewConflict();
  return Date.parse(parsed.data);
}

function compareReviewOrder(left: DecisiveReview, right: DecisiveReview) {
  return Date.parse(left.submitted_at) - Date.parse(right.submitted_at) || left.id - right.id;
}

async function readLatestDecisions(github: GitHub, pull: MergedPull, signal: AbortSignal) {
  const latest = new Map<number, DecisiveReview>();
  const seen = new Set<number>();
  const created = observedTime(pull.createdAt);
  for (let page = 1; page <= reviewPageLimit; page++) {
    const { data, hasNextPage } = await github.readReviewPage(pull.number, page, signal);
    const reviews = reviewPage.safeParse(data);
    if (!reviews.success) throw new ImprovementAdoptionGitHubError("remote_unavailable");
    const now = Date.now();
    for (const review of reviews.data) {
      if (seen.has(review.id)) throw new ImprovementAdoptionGitHubError("remote_unavailable");
      seen.add(review.id);
      if (!("user" in review) || !review.user || review.user.type !== "User") continue;
      if (review.user.id === pull.authorId) continue;
      if (!login.safeParse(review.user.login).success) return reviewConflict();
      const submitted = Date.parse(review.submitted_at);
      if (submitted < created || submitted > now) return reviewConflict();
      const decision = { ...review, user: review.user };
      const previous = latest.get(decision.user.id);
      if (!previous || compareReviewOrder(decision, previous) > 0) {
        latest.set(decision.user.id, decision);
      }
    }
    if (!hasNextPage && reviews.data.length < reviewsPerPage) return [...latest.values()];
  }
  throw new ImprovementAdoptionGitHubError("remote_unavailable");
}

async function hasCurrentPushAuthority(
  github: GitHub,
  { user }: DecisiveReview,
  signal: AbortSignal,
) {
  const result = await github.readReviewerPermission(user.login, signal);
  if (result === null) return false;
  const parsed = reviewerPermission.safeParse(result);
  if (!parsed.success) throw new ImprovementAdoptionGitHubError("remote_unavailable");
  const authority = parsed.data;
  if (
    authority.user.type !== "User" ||
    authority.user.id !== user.id ||
    authority.user.login.toLowerCase() !== user.login.toLowerCase()
  ) {
    return false;
  }
  return authority.permission === "admin" || authority.permission === "write";
}

async function findCurrentApproval(github: GitHub, pull: MergedPull, signal: AbortSignal) {
  const decisions = await readLatestDecisions(github, pull, signal);
  for (const decision of decisions) {
    if (
      decision.state === "CHANGES_REQUESTED" &&
      (await hasCurrentPushAuthority(github, decision, signal))
    ) {
      return reviewConflict();
    }
  }
  const merged = observedTime(pull.mergedAt);
  const approvals = decisions
    .filter(
      (decision) =>
        decision.state === "APPROVED" &&
        decision.commit_id === pull.sourceHeadSha &&
        Date.parse(decision.submitted_at) <= merged,
    )
    .sort((left, right) => compareReviewOrder(right, left));
  for (const approval of approvals) {
    if (await hasCurrentPushAuthority(github, approval, signal)) return approval;
  }
  return reviewConflict();
}

function classifyGitHubError(error: unknown) {
  if (error instanceof ImprovementAdoptionGitHubError) return error;
  if (
    error instanceof ImprovementPublicationGitHubError &&
    error.code !== "remote_unavailable" &&
    error.code !== "invalid_response"
  ) {
    return new ImprovementAdoptionGitHubError("review_conflict");
  }
  return new ImprovementAdoptionGitHubError("remote_unavailable");
}

export function createFactoryImprovementReviewVerifier({
  publication,
  token,
  signal: caller,
  fetcher,
}: {
  publication: ReviewPublication;
  token: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  async function observe(includeDefinition: boolean) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(proofTimeoutMs)]);
    try {
      signal.throwIfAborted();
      const { target, pullRequest, baseCommitSha, baseTreeSha, headCommitSha, headTreeSha } =
        publication;
      if (!pullRequest || !baseCommitSha || !baseTreeSha || !headCommitSha || !headTreeSha) {
        return reviewConflict();
      }
      const github = createImprovementAdoptionGitHub({ target, token, fetcher });
      const command = { pullNumber: pullRequest.number, baseCommitSha, headCommitSha, signal };
      const pull = await github.verifyMergedPullRequest(command);
      const created = observedTime(pull.createdAt);
      const merged = observedTime(pull.mergedAt);
      const updated = observedTime(pull.updatedAt);
      if (
        pull.url.toLowerCase() !== pullRequest.url.toLowerCase() ||
        pull.sourceHeadSha !== headCommitSha ||
        created > merged ||
        merged > updated ||
        updated > Date.now()
      ) {
        return reviewConflict();
      }
      const base = {
        commitSha: baseCommitSha,
        treeSha: baseTreeSha,
        fileSha256: publication.base.digest,
      };
      const head = { commitSha: headCommitSha, treeSha: headTreeSha };
      const candidateDigest = publication.candidate.digest;
      const [approval, definitionJson] = await Promise.all([
        findCurrentApproval(github, pull, signal),
        includeDefinition
          ? github.readVerifiedHead({ base, head, candidateDigest, requireRef: false, signal })
          : Promise.resolve(null),
        github.verifyMergedBranch({
          baseCommitSha,
          head,
          mergeCommitSha: pull.mergeCommitSha,
          candidateDigest,
          signal,
        }),
      ]);
      const current = await github.verifyMergedPullRequest(command);
      if (!isDeepStrictEqual(current, pull)) return reviewConflict();
      signal.throwIfAborted();
      const proof: FactoryImprovementReviewProof = {
        repositoryNumericId: target.repositoryNumericId,
        pullNumber: pull.number,
        pullUrl: pullRequest.url,
        baseCommitSha,
        headCommitSha,
        mergeCommitSha: pull.mergeCommitSha,
        reviewerId: approval.user.id,
        reviewerLogin: approval.user.login,
        reviewId: String(approval.id),
        reviewedAt: approval.submitted_at,
        mergedAt: pull.mergedAt,
        observedAt: new Date().toISOString(),
      };
      return { definitionJson, proof };
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }

  return {
    async read(): Promise<{ definitionJson: string; proof: FactoryImprovementReviewProof }> {
      const { proof, definitionJson } = await observe(true);
      if (definitionJson === null) return reviewConflict();
      return { definitionJson, proof };
    },

    async assertCurrent(proof: FactoryImprovementReviewProof): Promise<void> {
      const original = factoryImprovementReviewProofSchema.safeParse(proof);
      if (!original.success) return reviewConflict();
      const { observedAt, ...expected } = original.data;
      const observed = observedTime(observedAt);
      if (observed < observedTime(expected.mergedAt) || observed > Date.now()) {
        return reviewConflict();
      }
      const { proof: current } = await observe(false);
      if (!isDeepStrictEqual({ ...current, observedAt }, original.data)) return reviewConflict();
    },
  };
}
