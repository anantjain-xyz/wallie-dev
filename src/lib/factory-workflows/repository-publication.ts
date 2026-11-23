import "server-only";

import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";

export type PublicationScope = Readonly<{
  workspaceId: string;
  factoryId: string;
  rootSessionId: string;
  parentSessionId: string;
  joinId: string;
}>;

type RepositoryPublicationTarget = Readonly<{
  scope: PublicationScope;
  repositoryId: string;
  repositoryNumericId: number;
  repositoryFullName: string;
  expectedHeadReceiptId: string;
  baseSha: string;
  validationRunId: string;
  candidateSha: string;
  validationTreeSha: string;
  grantId: string;
  grantVersion: number;
}>;

export type RetainedRepositoryPublication = RepositoryPublicationTarget &
  Readonly<{ bundleSha256: string; retainedRef: string }>;

export type RepositoryPublication =
  | RetainedRepositoryPublication
  | (RepositoryPublicationTarget & Readonly<{ bundleSha256: null; retainedRef: null }>);

export type PublicationLease = Readonly<{
  target: RepositoryPublication;
  generation: number;
  leaseId: string;
  expiresAt: string;
}>;

export type RemoteProof = Readonly<{
  repositoryNumericId: number;
  ref: string;
  sha: string;
}>;

type Settlement =
  | { action: "verify" }
  | { action: "retry" }
  | {
      action: "adopt";
      proof: RemoteProof | { repositoryNumericId: number; ref: null; sha: null };
    }
  | { action: "incompatible_ref"; proof: RemoteProof };

export interface PublicationStore {
  settle(lease: PublicationLease, request: Settlement): Promise<string>;
}

export interface RetainedCheckpointPublisher {
  /** Read the exact ref after checking the hosting provider's repository identity. */
  read(target: RetainedRepositoryPublication, signal: AbortSignal): Promise<RemoteProof | null>;
  /** Create the ref only if it is still absent. Recheck authority at the write. */
  push(
    target: RetainedRepositoryPublication,
    beforePush: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const BUNDLE_SHA256 = /^[a-f0-9]{64}$/;

class PublicationFence extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Recover ambiguous writes by independently observing the exact retained ref. */
export async function publishClaimedRepositoryCheckpoint(
  store: PublicationStore,
  publisher: RetainedCheckpointPublisher,
  lease: PublicationLease,
  signal?: AbortSignal,
): Promise<string> {
  const remainingMs = Date.parse(lease.expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || signal?.aborted) {
    return "stale_lease";
  }
  const expiry = AbortSignal.timeout(Math.min(remainingMs, 120_000));
  const operation = signal ? AbortSignal.any([expiry, signal]) : expiry;
  const { target } = lease;
  const settle = (request: Settlement) => {
    operation.throwIfAborted();
    return store.settle(lease, request);
  };
  const assertCurrent = async () => {
    const result = await settle({ action: "verify" });
    if (result !== "current") throw new PublicationFence(result);
    operation.throwIfAborted();
  };

  try {
    if (
      !Number.isSafeInteger(target.repositoryNumericId) ||
      target.repositoryNumericId <= 0 ||
      !COMMIT_SHA.test(target.baseSha) ||
      !COMMIT_SHA.test(target.candidateSha) ||
      !COMMIT_SHA.test(target.validationTreeSha) ||
      (target.retainedRef === null
        ? target.candidateSha !== target.baseSha
        : target.candidateSha === target.baseSha ||
          !BUNDLE_SHA256.test(target.bundleSha256) ||
          !isWallieCheckpointRef(target.retainedRef, target.candidateSha, target.validationRunId))
    ) {
      return await settle({ action: "retry" });
    }

    await assertCurrent();
    if (target.retainedRef === null) {
      return await settle({
        action: "adopt",
        proof: { repositoryNumericId: target.repositoryNumericId, ref: null, sha: null },
      });
    }

    let observed = await publisher.read(target, operation);
    if (observed === null) {
      try {
        operation.throwIfAborted();
        await publisher.push(target, assertCurrent, operation);
      } catch (error) {
        if (error instanceof PublicationFence) throw error;
        await assertCurrent();
      }
      operation.throwIfAborted();
      observed = await publisher.read(target, operation);
    }

    if (
      observed === null ||
      observed.repositoryNumericId !== target.repositoryNumericId ||
      observed.ref !== target.retainedRef ||
      !COMMIT_SHA.test(observed.sha)
    ) {
      return await settle({ action: "retry" });
    }

    if (observed.sha !== target.candidateSha) {
      return await settle({ action: "incompatible_ref", proof: observed });
    }
    return await settle({ action: "adopt", proof: observed });
  } catch (error) {
    if (error instanceof PublicationFence) return error.reason;
    if (operation.aborted) return "stale_lease";
    return settle({ action: "retry" });
  }
}
