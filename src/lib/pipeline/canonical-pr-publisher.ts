import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { CanonicalPrApiError, createCanonicalPrApi } from "./canonical-pr-api";
import { CanonicalRefConflictError, promoteCanonicalRefsWithWorkspace } from "./canonical-pr-git";
import { resolveSourceDeliveryRepository } from "./source-delivery";
import { withSourceGitSandbox } from "./source-delivery-sandbox";

type Admin = SupabaseClient<Database>;
type Operation = Tables<"session_pr_operations">;
type Epoch = Tables<"session_pr_epochs">;

/** Immutable operations survive response loss; only a live claim may acknowledge one. */
export async function publishCanonicalPullRequest(
  admin: Admin,
  operation: Operation,
  epoch: Epoch,
  signal: AbortSignal,
) {
  const assertClaim = async () => {
    signal.throwIfAborted();
    const { data, error } = await admin
      .rpc("assert_session_pr_sync_claim", {
        p_operation_id: operation.id,
        p_claim_id: operation.claim_id!,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error || data !== true) throw new Error("Canonical PR claim expired.");
  };
  await assertClaim();
  if (
    epoch.id !== operation.epoch_id ||
    epoch.session_id !== operation.session_id ||
    epoch.workspace_id !== operation.workspace_id
  )
    throw new Error("Canonical PR scope does not match its operation.");
  if (epoch.pr_state === "closed" || epoch.pr_state === "merged")
    throw new Error("Canonical PR requires an explicit successor.");
  const repository = await resolveSourceDeliveryRepository(admin, epoch, signal);
  if (
    repository.repositoryNumericId !== epoch.github_repository_id ||
    repository.delivery.repository_full_name !== epoch.repository_full_name
  )
    throw new Error("Canonical PR repository identity changed.");
  const api = createCanonicalPrApi({
    repositoryFullName: epoch.repository_full_name,
    repositoryNumericId: epoch.github_repository_id,
    branchName: epoch.branch_name,
    baseBranch: epoch.base_branch,
    token: repository.token,
    signal,
  });
  // Pinned identities are GET-only: a deleted/inaccessible PR never permits a replacement.
  let pr = epoch.pr_number ? await api.get(epoch.pr_number) : await api.find();
  const finish = async (headSha: string | null, fenceSha: string | null) => {
    if (!pr) throw new Error("Canonical pull request has not been observed.");
    await assertClaim();
    const { data: observationId, error: observationError } = await admin
      .rpc("begin_session_pr_sync_observation", {
        p_operation_id: operation.id,
        p_claim_id: operation.claim_id!,
        p_pr_number: pr.number,
        p_pr_url: pr.url,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (observationError || !observationId)
      throw new Error("Canonical PR observation could not be reserved.");
    const prior = pr;
    const current = await api.get(pr.number);
    // Once terminal state has been observed, external reopening does not grant
    // this epoch permission to publish again.
    pr = prior.state === "open" ? current : prior;
    await assertClaim();
    const { data, error } = await admin
      .rpc("finish_session_pr_sync", {
        p_operation_id: operation.id,
        p_claim_id: operation.claim_id!,
        p_observed_head_sha: headSha!,
        p_observed_fence_sha: fenceSha!,
        p_pr_number: pr.number,
        p_pr_url: pr.url,
        p_pr_state: pr.state,
        p_is_draft: pr.draft,
        p_pr_head_sha: pr.headSha,
        p_pr_updated_at: pr.updatedAt,
        p_observation_id: observationId,
      })
      .abortSignal(signal);
    if (error || !data) throw new Error("Canonical PR receipt could not be accepted.");
  };
  if (pr && pr.state !== "open") {
    await finish(null, null);
    return;
  }
  const remote = await withSourceGitSandbox(
    signal,
    { admin, workspaceId: operation.workspace_id, runId: operation.checkpoint_run_id },
    (dependencies) =>
      promoteCanonicalRefsWithWorkspace(
        {
          operationId: operation.id,
          desiredSha: operation.desired_sha,
          sourceRef: operation.source_ref,
          branchName: epoch.branch_name,
          fenceRef: epoch.fence_branch.startsWith("refs/")
            ? epoch.fence_branch
            : `refs/heads/${epoch.fence_branch}`,
          expectedHeadSha: operation.expected_head_sha,
          expectedFenceSha: operation.expected_fence_sha,
          desiredFenceSha: operation.desired_fence_sha,
          remoteUrl: `https://github.com/${epoch.repository_full_name}.git`,
          token: repository.token,
          signal,
          beforePush: async () => {
            await assertClaim();
            // Close/merge cannot be atomic with a Git transaction. Check immediately
            // before it, then re-observe afterward; a raced closure is never success.
            if (pr) {
              pr = await api.get(pr.number);
              if (pr.state !== "open") {
                await finish(null, null);
                throw new Error("Canonical PR became terminal.");
              }
            }
          },
        },
        dependencies,
      ),
  );
  await assertClaim();
  if (!pr) pr = await api.find();
  if (!pr) {
    const { data: session, error: sessionError } = await admin
      .from("sessions")
      .select("title")
      .eq("id", operation.session_id)
      .eq("workspace_id", operation.workspace_id)
      .abortSignal(signal)
      .single();
    if (sessionError || !session) throw new Error("Canonical PR session is unavailable.");
    const { data: armed, error } = await admin
      .rpc("arm_session_pr_creation", {
        p_epoch_id: epoch.id,
        p_operation_id: operation.id,
        p_claim_id: operation.claim_id!,
      })
      .abortSignal(signal);
    if (error) throw new Error("Canonical PR creation could not be authorized.");
    if (!armed) {
      // An earlier POST may still have committed. Recovery observes all states;
      // it never repeats an uncertain write or silently creates a successor.
      throw new CanonicalPrApiError("pr_creation_uncertain");
    }
    await assertClaim();
    try {
      pr = await api.create({
        title: session.title.slice(0, 256),
        body: `Wallie session ${operation.session_id}\n\nAccepted checkpoint: ${operation.checkpoint_run_id}`,
      });
    } catch (error) {
      // A failed response is not proof that POST failed. Find closed PRs too.
      try {
        pr = await api.find();
      } catch {
        // A failed recovery GET must not erase definitive non-creation proof
        // from the POST response. The next claim still reconciles before POST.
        throw error;
      }
      if (!pr) throw error;
    }
  }
  // Reserve a shared observation token BEFORE the authoritative final GET.
  await finish(remote.headSha, remote.fenceSha);
}

/** Maintenance retries the durable obligation independently of artifact review. */
export async function drainCanonicalPullRequests(
  admin: Admin,
  options: { limit?: number; timeoutMs?: number; sessionId?: string } = {},
) {
  const result = { processed: 0, failed: 0 };
  for (let index = 0; index < (options.limit ?? 3); index++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Canonical PR timed out.")),
        {
          once: true,
        },
      ),
    );
    let operation: Operation | null = null;
    try {
      const work = (async () => {
        const { data: claim, error: claimError } = await admin
          .rpc("claim_session_pr_sync", {
            ...(options.sessionId ? { p_session_id: options.sessionId } : {}),
          })
          .abortSignal(controller.signal);
        if (claimError) throw new Error("Canonical PR claim failed.");
        if (!claim) return false;
        const { data, error } = await admin
          .from("session_pr_operations")
          .select("*")
          .eq("claim_id", claim)
          .abortSignal(controller.signal)
          .single();
        if (error || !data) throw new Error("Canonical PR operation is unavailable.");
        operation = data;
        const { data: epoch, error: epochError } = await admin
          .from("session_pr_epochs")
          .select("*")
          .eq("id", operation.epoch_id)
          .eq("workspace_id", operation.workspace_id)
          .eq("session_id", operation.session_id)
          .abortSignal(controller.signal)
          .single();
        if (epochError || !epoch) throw new Error("Canonical PR epoch is unavailable.");
        await publishCanonicalPullRequest(admin, operation, epoch, controller.signal);
        return true;
      })();
      if (!(await Promise.race([work, aborted]))) break;
      result.processed++;
    } catch (error) {
      result.failed++;
      const currentOperation = operation as Operation | null;
      if (currentOperation?.claim_id && !controller.signal.aborted) {
        const conflict =
          error instanceof CanonicalRefConflictError ||
          (error instanceof CanonicalPrApiError &&
            ["pr_identity_conflict", "pr_multiple_matches"].includes(error.code));
        const creationSafe = error instanceof CanonicalPrApiError && error.retryCreationSafe;
        await Promise.race([
          admin
            .rpc("fail_session_pr_sync", {
              p_operation_id: currentOperation.id,
              p_claim_id: currentOperation.claim_id,
              p_error_code: conflict
                ? "external_ref_conflict"
                : creationSafe
                  ? "pr_creation_rejected"
                  : error instanceof CanonicalPrApiError
                    ? error.code
                    : "publication_failed",
              p_is_conflict: conflict,
              p_retry_creation_safe: creationSafe,
            })
            .abortSignal(controller.signal),
          aborted,
        ]).catch(() => undefined);
      }
      // Transport errors may contain authorization material: log identities only.
      console.warn("[canonical-pr] synchronization deferred", {
        operationId: currentOperation?.id,
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return result;
}
