import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import type { Database, Json } from "@/lib/supabase/database.types";

import { mintPrVerificationToken, PrVerificationAuthError } from "./pr-verification-auth";
import { collectPrVerification, PrVerificationApiError } from "./pr-verification-api";

const claimSchema = z.object({
  session_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  claim_token: z.string().uuid(),
  policy_revision_id: z.string().uuid(),
  requirements: deliveryRequirementsSchema,
  artifact_review_revision: z.number().int().nonnegative().safe(),
  checkpoint_run_id: z.string().uuid(),
  repository_id: z.string().uuid(),
  repository_full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  github_repository_id: z.number().int().positive().safe(),
  installation_id: z.number().int().positive().safe(),
  installation_suspended: z.boolean(),
  repository_archived: z.boolean(),
  pr_epoch_id: z.string().uuid(),
  pr_number: z.number().int().positive().safe(),
  branch_name: z.string().min(1),
  base_branch: z.string().min(1),
});

/** Independent, bounded intake: no agent job, artifact, or approval mutation. */
export async function reconcileGitHubPrVerification(
  admin: SupabaseClient<Database>,
  options: {
    workspaceId?: string;
    input?: Record<string, string | undefined>;
  } = {},
): Promise<{ checked: number; refreshed: number; failed: number }> {
  const result = { checked: 0, refreshed: 0, failed: 0 };
  const signal = AbortSignal.timeout(40_000);
  const { error: enqueueError } = await admin
    .rpc("enqueue_due_github_pr_refreshes", {
      p_limit: 20,
      ...(options.workspaceId ? { p_workspace_id: options.workspaceId } : {}),
    })
    .abortSignal(signal);
  if (enqueueError) throw new Error("GitHub refresh scheduling is unavailable.");
  for (let count = 0; count < 3 && !signal.aborted; count++) {
    const { data, error } = await admin
      .rpc("claim_github_pr_refresh", {
        ...(options.workspaceId ? { p_workspace_id: options.workspaceId } : {}),
      })
      .abortSignal(signal);
    if (error) throw new Error("GitHub refresh claims are unavailable.");
    if (!data) break;
    const claim = claimSchema.parse(data);
    if (options.workspaceId && claim.workspace_id !== options.workspaceId)
      throw new Error("GitHub refresh claim crossed its workspace boundary.");
    result.checked++;
    let completion: {
      p_head_sha?: string;
      p_base_sha?: string;
      p_payload?: Json;
      p_error_code?: string;
    };
    try {
      if (claim.installation_suspended || claim.repository_archived)
        throw new Error("GitHub repository access is unavailable.");
      const credential = await mintPrVerificationToken({
        installationId: claim.installation_id,
        repositoryNumericId: claim.github_repository_id,
        signal,
        environment: options.input,
      });
      const snapshot = await collectPrVerification({
        ...credential,
        repositoryFullName: claim.repository_full_name,
        repositoryNumericId: claim.github_repository_id,
        prNumber: claim.pr_number,
        branchName: claim.branch_name,
        baseBranch: claim.base_branch,
        signal,
        requirements: claim.requirements,
      });
      completion = {
        p_head_sha: snapshot.headSha,
        p_base_sha: snapshot.baseSha,
        p_payload: snapshot.payload as Json,
      };
    } catch (error) {
      completion = {
        p_error_code:
          error instanceof PrVerificationApiError || error instanceof PrVerificationAuthError
            ? error.code
            : "github_refresh_failed",
      };
    }
    // Finishing gets a separate short deadline so an expired provider request
    // can persist an explicit error. A crashed worker's lease is recoverable.
    const { data: accepted, error: finishError } = await admin
      .rpc("finish_github_pr_refresh", {
        p_session_id: claim.session_id,
        p_claim_token: claim.claim_token,
        ...completion,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (finishError) throw new Error("GitHub refresh completion is unavailable.");
    if (accepted && !completion.p_error_code) result.refreshed++;
    if (accepted && completion.p_error_code) result.failed++;
  }
  return result;
}
