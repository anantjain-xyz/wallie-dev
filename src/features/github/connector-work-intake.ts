import "server-only";

import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { pullRequestEventSchema } from "./webhook-payloads";

const githubId = z.number().int().positive().safe();
const sourceNumber = z.number().int().positive().max(2_147_483_647);
const workAction = z.enum([
  "labeled",
  "unlabeled",
  "closed",
  "opened",
  "reopened",
  "edited",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
]);
const actionPayload = z.object({ action: workAction });
const envelope = actionPayload.extend({
  installation: z.object({ id: githubId }),
  repository: z.object({ id: githubId, owner: z.object({ id: githubId }) }),
  sender: z.object({ id: githubId, type: z.string().min(1) }),
  label: z.object({ id: githubId }).optional(),
});
const sourceContent = {
  title: z.string().optional(),
  body: z.string().nullable().optional(),
};
const issuePayload = envelope.extend({
  issue: z.object({
    id: githubId,
    number: sourceNumber,
    state: z.enum(["open", "closed"]),
    updated_at: z.string().datetime({ offset: true }),
    pull_request: z.undefined(),
    ...sourceContent,
  }),
});
const pullRequestPayload = envelope.extend({
  pull_request: pullRequestEventSchema.shape.pull_request.extend({
    ...sourceContent,
    id: githubId,
    base: z.object({ ref: z.string().min(1).max(1013), repo: z.object({ id: githubId }) }),
    head: pullRequestEventSchema.shape.pull_request.shape.head.extend({
      ref: z.string().min(1).max(1013),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    }),
  }),
});

export function isGitHubConnectorWorkAction(payload: unknown) {
  return actionPayload.safeParse(payload).success;
}

function eventScope(payload: z.output<typeof envelope>, deliveryId: string) {
  return {
    p_installation_id: payload.installation.id,
    p_github_repository_id: payload.repository.id,
    p_owner_id: payload.repository.owner.id,
    p_delivery_id: deliveryId,
    p_action: payload.action,
    p_sender_id: payload.sender.id,
    p_sender_kind: payload.sender.type === "User" ? ("human" as const) : ("service" as const),
    ...(payload.label ? { p_label_id: payload.label.id } : {}),
  };
}

function hasExpectedLabel(payload: z.output<typeof envelope>) {
  return (
    (payload.action === "labeled" || payload.action === "unlabeled") === Boolean(payload.label)
  );
}

function requestContext(action: string, item: { title?: string; body?: string | null }) {
  if (action !== "labeled") return {};
  const bounded = (value: string, max: number) =>
    Array.from(value.replaceAll("\0", "")).slice(0, max).join("");
  return {
    ...(item.title === undefined ? {} : { p_source_title: bounded(item.title, 256) }),
    ...(item.body == null ? {} : { p_source_body: bounded(item.body, 8000) }),
  };
}

function connectorWorkEvent(kind: "issues" | "pull_request", input: unknown, deliveryId: string) {
  if (kind === "issues") {
    const parsed = issuePayload.safeParse(input);
    if (!parsed.success || !hasExpectedLabel(parsed.data)) return null;
    const { issue } = parsed.data;
    return {
      ...eventScope(parsed.data, deliveryId),
      ...requestContext(parsed.data.action, issue),
      p_source_kind: "issue",
      p_source_id: issue.id,
      p_source_number: issue.number,
      p_state: issue.state,
      p_provider_updated_at: issue.updated_at,
    };
  }

  const parsed = pullRequestPayload.safeParse(input);
  if (!parsed.success || !hasExpectedLabel(parsed.data)) return null;
  const { pull_request: pr, repository } = parsed.data;
  if (pr.base.repo.id !== repository.id) return null;
  // Foreign or deleted heads can advance the source watermark but cannot start work.
  const refs =
    pr.head.repo?.id === repository.id
      ? { p_head_ref: pr.head.ref, p_head_sha: pr.head.sha, p_base_ref: pr.base.ref }
      : {};
  return {
    ...eventScope(parsed.data, deliveryId),
    ...requestContext(parsed.data.action, pr),
    ...refs,
    p_source_kind: "pull_request",
    p_source_id: pr.id,
    p_source_number: pr.number,
    p_state: pr.state,
    p_provider_updated_at: pr.updated_at,
  };
}

/** Called only after verifying the exact webhook body and delivery header. */
export async function captureGitHubConnectorWork(
  kind: "issues" | "pull_request",
  input: unknown,
  deliveryId: string,
) {
  const event = connectorWorkEvent(kind, input, deliveryId);
  if (!event) return false;
  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .rpc("ingest_github_connector_work", event)
    .abortSignal(AbortSignal.timeout(8_000));
  if (error) throw new Error("Could not capture the GitHub connector event.", { cause: error });
  return true;
}
