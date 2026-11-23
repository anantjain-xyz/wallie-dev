import "server-only";

import { z } from "zod";

import { automationFilterTextSchema } from "@/lib/factory-automations/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { pullRequestEventSchema } from "./webhook-payloads";

const githubId = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const openActions = z.enum(["opened", "reopened", "synchronize", "ready_for_review"]);

const automationPullRequestPayload = pullRequestEventSchema.extend({
  installation: z.object({ id: githubId }),
  pull_request: pullRequestEventSchema.shape.pull_request.extend({
    id: githubId,
    base: z.object({ ref: automationFilterTextSchema, repo: z.object({ id: githubId }) }),
    head: pullRequestEventSchema.shape.pull_request.shape.head.extend({
      ref: z.string().min(1).max(1013),
      sha,
    }),
    merge_commit_sha: sha.nullable().optional(),
  }),
});

export async function captureGitHubAutomationPullRequest(payload: unknown, deliveryId: string) {
  const parsed = automationPullRequestPayload.safeParse(payload);
  if (!parsed.success) return;

  const { action, installation, pull_request: pr, repository } = parsed.data;
  if (pr.base.repo.id !== repository.id) return;

  const openAction = openActions.safeParse(action);
  const merged = action === "closed" && pr.state === "closed" && pr.merged;
  const closed = action === "closed" && pr.state === "closed" && !pr.merged;
  const opened = openAction.success && pr.state === "open" && !pr.merged;
  if ((!merged && !closed && !opened) || (merged && !pr.merge_commit_sha)) return;

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .rpc("ingest_factory_github_automation_pr", {
      p_installation_id: installation.id,
      p_github_repository_id: repository.id,
      p_delivery_id: deliveryId,
      p_pull_request_id: pr.id,
      p_pull_request_number: pr.number,
      p_action: merged ? "merged" : action,
      p_state: merged ? "merged" : pr.state,
      p_draft: pr.draft,
      p_provider_updated_at: pr.updated_at,
      p_base_branch: pr.base.ref,
      p_head_branch: pr.head.ref,
      p_head_sha: pr.head.sha,
      ...(pr.head.repo ? { p_head_repository_id: pr.head.repo.id } : {}),
      ...(merged && pr.merge_commit_sha ? { p_merge_commit_sha: pr.merge_commit_sha } : {}),
    })
    .abortSignal(AbortSignal.timeout(8_000));
  if (error)
    throw new Error("Could not capture the GitHub pull request automation event.", {
      cause: error,
    });
}
