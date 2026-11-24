import "server-only";

import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Admin = Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">;
const retryableTransactionCodes = new Set(["55P03", "40P01", "40001"]);
const githubId = z.number().int().positive().safe();
const account = z.object({ id: githubId, type: z.string().min(1) });
const commentPayload = z.object({
  action: z.enum(["created", "edited", "deleted"]),
  installation: z.object({ id: githubId }),
  repository: z.object({ id: githubId, owner: z.object({ id: githubId }) }),
  issue: z.object({
    id: githubId,
    number: z.number().int().positive().max(2_147_483_647),
    pull_request: z.object({ url: z.string().url() }).optional(),
  }),
  sender: account,
  comment: z.object({
    id: githubId,
    user: account,
    updated_at: z.string().datetime({ offset: true }),
    body: z.string().nullish(),
  }),
});

function conversationBody(value: string) {
  const safeText = value.replace(/[\u0000\uD800-\uDFFF]/gu, "�");
  const excerpt = Array.from(safeText).slice(0, 8000).join("");
  if (excerpt.trim() !== "") return excerpt;
  return Array.from(safeText.trimStart()).slice(0, 8000).join("");
}

/** The webhook route verifies the signature on the original bytes before calling this. */
export async function captureGitHubConnectorComment(input: unknown, deliveryId: string) {
  const parsed = commentPayload.safeParse(input);
  if (!parsed.success) return false;

  const { action, installation, repository, issue, sender, comment } = parsed.data;
  if (
    sender.type !== "User" ||
    comment.user.type !== "User" ||
    (action !== "deleted" && sender.id !== comment.user.id)
  ) {
    return true;
  }

  const body = action === "deleted" ? undefined : conversationBody(comment.body ?? "");
  if (body?.trim() === "") return true;

  const admin = createSupabaseAdminClient();
  const delivery = {
    p_installation_id: installation.id,
    p_github_repository_id: repository.id,
    p_owner_id: repository.owner.id,
    p_delivery_id: deliveryId,
    p_action: action,
    p_source_kind: issue.pull_request ? "pull_request" : "issue",
    p_source_number: issue.number,
    p_issue_id: issue.id,
    p_comment_id: comment.id,
    p_actor_id: comment.user.id,
    p_provider_updated_at: comment.updated_at,
    ...(body === undefined ? {} : { p_body: body }),
  };
  const { error } = await admin
    .rpc("ingest_github_connector_comment", delivery)
    .abortSignal(AbortSignal.timeout(8_000));
  if (!error) return true;
  if (error.code && !retryableTransactionCodes.has(error.code)) {
    throw new Error("Could not capture the GitHub connector comment.", { cause: error });
  }

  const { error: deferError } = await admin
    .rpc("defer_github_connector_comment", delivery)
    .abortSignal(AbortSignal.timeout(5_000));
  if (deferError) {
    throw new Error("Could not defer the GitHub connector comment.", { cause: deferError });
  }
  return true;
}

export async function drainGitHubConnectorCommentRetries(admin: Admin) {
  const { error } = await admin
    .rpc("drain_github_connector_comment_retries")
    .abortSignal(AbortSignal.timeout(12_000));
  if (error) throw new Error("Could not retry deferred GitHub comments.", { cause: error });
}
