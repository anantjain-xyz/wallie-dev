import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { buildAppUrl } from "@/lib/app-url";
import {
  drainConnectorOutboundDeliveries,
  type ConnectorOutboundAdapter,
  type ConnectorOutboundTarget,
} from "@/lib/connectors/outbound";
import { LINEAR_GRAPHQL_ENDPOINT, linearRetryAfterSeconds } from "@/lib/linear/client";
import { currentLinearStateSpan, linearInstant, linearStateSpan } from "@/lib/linear/state-spans";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { exactSessionReviewHref } from "@/lib/sessions/review-link";
import type { Database } from "@/lib/supabase/database.types";

type Admin = Pick<SupabaseClient<Database>, "rpc">;
type Send = Awaited<ReturnType<ConnectorOutboundAdapter["send"]>>;
type Observation = Awaited<ReturnType<ConnectorOutboundAdapter["observe"]>>;
type SendFence = () => Promise<
  { kind: "rejected" | "not_sent" } | { kind: "credential_unavailable" } | null
>;
type Failure =
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "credential_unavailable" }
  | { kind: "denied" }
  | { kind: "unknown" };

const uuid = z.uuid().toLowerCase();
const node = z.object({ id: uuid });
const delivery = z.object({
  issue_id: uuid,
  external_tenant_id: uuid,
  resource_kind: z.enum(["team", "project"]),
  resource_external_id: uuid,
  origin_state_id: uuid,
  origin_team_id: uuid,
  origin_project_id: uuid.nullable(),
  origin_span_id: z.string().min(1).nullable(),
  origin_span_started_at: linearInstant.nullable(),
  encrypted_api_key: z.string().min(1),
  may_send: z.boolean(),
  from_state_id: uuid.nullable(),
  to_state_id: uuid.nullable(),
  credential_material_revision: z.number().int().positive(),
});
type Delivery = z.output<typeof delivery>;

const noticeBase = z.object({
  sessionId: uuid,
  workspaceSlug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  sessionNumber: z.number().int().positive().max(2_147_483_647),
  body: z.string().trim().min(1).max(2000),
});
const notice = z.discriminatedUnion("kind", [
  noticeBase.extend({ kind: z.enum(["progress", "outcome"]) }),
  noticeBase.extend({
    kind: z.literal("review_ready"),
    reviewTarget: z.object({
      stageId: uuid,
      stageSlug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(100),
      artifactId: uuid,
      artifactVersion: z.number().int().positive().max(2_147_483_647),
      reviewRevision: z.number().int().nonnegative(),
    }),
  }),
]);
const statusNotice = z.object({ kind: z.literal("linear_status") });

const issue = z.object({
  id: uuid,
  archivedAt: linearInstant.nullable(),
  trashed: z.boolean().nullable(),
  team: node,
  project: node.nullable(),
});
const commentScope = z.object({ organization: node, issue: issue.nullable() });
const statusIssue = issue.extend({
  state: node,
  updatedAt: linearInstant,
  stateHistory: z.object({ nodes: z.array(linearStateSpan).max(2) }),
});
const statusScope = commentScope.extend({
  issue: statusIssue.nullable(),
  workflowState: node
    .extend({ team: node, archivedAt: linearInstant.nullable() })
    .nullable()
    .optional(),
});
const comment = node.extend({ issue: node, body: z.string() });
const commentWrite = z.object({
  commentCreate: z.object({ success: z.boolean(), comment: comment.nullable() }),
});
const commentRead = z.object({ comment: comment.nullable() });
const statusWrite = z.object({
  issueUpdate: z.object({
    success: z.boolean(),
    issue: node.extend({ state: node }).nullable(),
  }),
});
const graphResponse = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() }))
    .optional(),
});

const issueFields = "id archivedAt trashed team { id } project { id }";
const commentScopeQuery = /* GraphQL */ `
  query WallieLinearCommentScope($id: String!) {
    organization { id }
    issue(id: $id) { ${issueFields} }
  }
`;
const statusScopeQuery = /* GraphQL */ `
  query WallieLinearStatusScope($id: String!, $to: String!, $checkDestination: Boolean!) {
    organization { id }
    issue(id: $id) {
      ${issueFields}
      updatedAt
      state { id }
      stateHistory(last: 2) { nodes { id stateId startedAt endedAt } }
    }
    workflowState(id: $to) @include(if: $checkDestination) { id team { id } archivedAt }
  }
`;
const createCommentQuery = /* GraphQL */ `
  mutation WallieLinearCreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        issue {
          id
        }
      }
    }
  }
`;
const readCommentQuery = /* GraphQL */ `
  query WallieLinearReadComment($id: String!) {
    comment(id: $id) {
      id
      body
      issue {
        id
      }
    }
  }
`;
const updateStatusQuery = /* GraphQL */ `
  mutation WallieLinearUpdateStatus($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        id
        state {
          id
        }
      }
    }
  }
`;

function providerRequests(key: string, fetcher: typeof fetch, signal: AbortSignal) {
  return async <Schema extends z.ZodType>(
    query: string,
    variables: Record<string, unknown>,
    schema: Schema,
  ): Promise<{ kind: "ok"; data: z.output<Schema> } | Failure> => {
    try {
      const response = await fetcher(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        redirect: "manual",
        signal,
      });
      const limited = (): Failure => ({
        kind: "rate_limited",
        retryAfterSeconds: linearRetryAfterSeconds(response),
      });
      if (response.status === 429) return limited();
      if (response.status === 401) return { kind: "credential_unavailable" };
      if (response.status === 403) return { kind: "denied" };
      if (!response.ok) return { kind: "unknown" };

      const payload = graphResponse.parse(await response.json());
      if (payload.errors?.length) {
        // Partial mutation results never establish that a write did not happen.
        if (payload.data == null) {
          const exactCode = (code: string) =>
            payload.errors?.every((error) => error.extensions?.code === code);
          if (exactCode("RATELIMITED")) return limited();
          if (exactCode("AUTHENTICATION_ERROR")) return { kind: "credential_unavailable" };
          if (exactCode("FORBIDDEN")) return { kind: "denied" };
        }
        return { kind: "unknown" };
      }
      return { kind: "ok", data: schema.parse(payload.data) };
    } catch {
      return { kind: "unknown" };
    }
  };
}
type Request = ReturnType<typeof providerRequests>;

async function readDelivery(
  admin: Admin,
  target: ConnectorOutboundTarget,
  signal: AbortSignal,
): Promise<Delivery | null> {
  if (target.credentialMaterialRevision === null) return null;
  const { data, error } = await admin
    .rpc("resolve_linear_connector_delivery", {
      p_delivery_id: target.correlationId,
      p_lease_id: target.leaseId,
      p_credential_ref: target.credentialRef,
      p_credential_material_revision: target.credentialMaterialRevision,
    })
    .abortSignal(signal);
  if (error) throw new Error("Could not resolve Linear delivery.");
  const [resolved] = z.union([z.tuple([]), z.tuple([delivery])]).parse(data);
  if (
    !resolved ||
    resolved.issue_id !== target.externalThreadId ||
    resolved.resource_external_id !== target.externalResourceId ||
    resolved.credential_material_revision !== target.credentialMaterialRevision
  ) {
    return null;
  }
  return resolved;
}

function isExactIssue(
  scope: z.output<typeof commentScope>,
  target: Delivery,
): scope is z.output<typeof commentScope> & { issue: z.output<typeof issue> } {
  const found = scope.issue;
  if (!found || found.archivedAt !== null || found.trashed) return false;
  const resourceId = target.resource_kind === "team" ? found.team.id : found.project?.id;
  return (
    found.id === target.issue_id &&
    scope.organization.id === target.external_tenant_id &&
    resourceId === target.resource_external_id
  );
}

function renderNotice(content: z.output<typeof notice>) {
  const session = buildAppUrl(
    workspaceSessionDetailPath(content.workspaceSlug, content.sessionNumber),
  );
  if (content.kind === "review_ready") {
    const review = buildAppUrl(
      exactSessionReviewHref(content.workspaceSlug, content.sessionNumber, {
        ...content.reviewTarget,
        clarificationId: null,
      }),
    );
    return `${content.body}\n\n[Review in Wallie](${review}) · [Wallie session](${session})`;
  }
  return `${content.body}\n\n[Wallie session](${session})`;
}

function isExactComment(
  found: z.output<typeof comment> | null,
  deliveryId: string,
  issueId: string,
  body: string,
) {
  return found?.id === deliveryId && found.issue.id === issueId && found.body === body;
}

function statusMatchesOrigin(
  target: Delivery,
  issue: z.output<typeof statusIssue>,
  span: z.output<typeof linearStateSpan> | null,
) {
  return (
    span !== null &&
    target.origin_span_id === span.id &&
    target.origin_span_started_at !== null &&
    Date.parse(target.origin_span_started_at) === Date.parse(span.startedAt) &&
    target.origin_state_id === span.stateId &&
    target.from_state_id === span.stateId &&
    target.origin_team_id === issue.team.id &&
    target.origin_project_id === (issue.project?.id ?? null)
  );
}

function beforeWrite(result: Failure): Send {
  return result.kind === "rate_limited" || result.kind === "credential_unavailable"
    ? result
    : { kind: "not_sent" };
}

function afterWrite(result: Failure): Send {
  return result.kind === "unknown" ? { kind: "uncertain" } : beforeWrite(result);
}

function observationFailure(result: Failure): Observation {
  return result.kind === "rate_limited" || result.kind === "credential_unavailable"
    ? result
    : { kind: "inconclusive" };
}

async function sendStatus(request: Request, target: Delivery, confirm: SendFence): Promise<Send> {
  if (!target.to_state_id || !target.origin_span_id) return { kind: "rejected" };
  const scope = await request(
    statusScopeQuery,
    { id: target.issue_id, to: target.to_state_id, checkDestination: true },
    statusScope,
  );
  if (scope.kind !== "ok") return beforeWrite(scope);
  const { issue, workflowState } = scope.data;
  if (!issue || issue.archivedAt !== null || issue.trashed) return { kind: "not_sent" };
  const open = currentLinearStateSpan(issue.stateHistory.nodes, issue.state.id, issue.updatedAt);
  if (
    !isExactIssue(scope.data, target) ||
    !statusMatchesOrigin(target, issue, open) ||
    workflowState?.id !== target.to_state_id ||
    workflowState.team.id !== issue.team.id ||
    workflowState.archivedAt !== null ||
    target.to_state_id === target.from_state_id
  ) {
    return { kind: "rejected" };
  }
  const blocked = await confirm();
  if (blocked) return blocked;

  // Linear accepts no expected-state argument. This read fences stale Wallie
  // intent but cannot make the provider mutation atomic with a human edit.
  const result = await request(
    updateStatusQuery,
    { id: target.issue_id, stateId: target.to_state_id },
    statusWrite,
  );
  if (result.kind !== "ok") return afterWrite(result);
  const updated = result.data.issueUpdate;
  return updated.success &&
    updated.issue?.id === target.issue_id &&
    updated.issue.state.id === target.to_state_id
    ? { kind: "sent", providerReplyId: target.issue_id }
    : { kind: "uncertain" };
}

async function observeStatus(request: Request, target: Delivery): Promise<Observation> {
  if (!target.to_state_id || !target.origin_span_id) return { kind: "inconclusive" };
  const scope = await request(
    statusScopeQuery,
    { id: target.issue_id, to: target.to_state_id, checkDestination: false },
    statusScope,
  );
  if (scope.kind !== "ok") return observationFailure(scope);
  const { issue } = scope.data;
  if (!issue || !isExactIssue(scope.data, target)) return { kind: "inconclusive" };
  const open = currentLinearStateSpan(issue.stateHistory.nodes, issue.state.id, issue.updatedAt);
  const prior = issue.stateHistory.nodes.at(-2);
  return open?.stateId === target.to_state_id &&
    prior?.endedAt &&
    statusMatchesOrigin(target, issue, prior) &&
    Date.parse(prior.endedAt) <= Date.parse(open.startedAt)
    ? { kind: "found", providerReplyId: target.issue_id }
    : { kind: "inconclusive" };
}

export function createLinearOutboundAdapter(
  admin: Admin,
  fetcher: typeof fetch = fetch,
): ConnectorOutboundAdapter {
  return {
    provider: "linear",
    async send(target, signal) {
      const resolved = await readDelivery(admin, target, signal).catch(() => undefined);
      if (resolved === undefined) return { kind: "not_sent" };
      if (!resolved) return { kind: "credential_unavailable" };
      if (!resolved.may_send || target.message.operation === "edit") return { kind: "rejected" };
      let request: Request;
      try {
        request = providerRequests(decryptSecretValue(resolved.encrypted_api_key), fetcher, signal);
      } catch {
        return { kind: "not_sent" };
      }
      const confirm: SendFence = async () => {
        const current = await readDelivery(admin, target, signal).catch(() => undefined);
        if (current === undefined) return { kind: "not_sent" };
        if (current === null) return { kind: "credential_unavailable" };
        return current.may_send ? null : { kind: "rejected" };
      };
      if (target.message.operation === "linear_status") {
        return statusNotice.safeParse(target.message.content).success
          ? sendStatus(request, resolved, confirm)
          : { kind: "rejected" };
      }

      const content = notice.safeParse(target.message.content);
      if (!content.success) return { kind: "rejected" };
      const scope = await request(commentScopeQuery, { id: resolved.issue_id }, commentScope);
      if (scope.kind !== "ok") return beforeWrite(scope);
      const { issue } = scope.data;
      if (!issue || issue.archivedAt !== null || issue.trashed) return { kind: "not_sent" };
      if (!isExactIssue(scope.data, resolved)) return { kind: "rejected" };
      const body = renderNotice(content.data);
      const blocked = await confirm();
      if (blocked) return blocked;
      const result = await request(
        createCommentQuery,
        {
          input: {
            id: target.correlationId,
            issueId: resolved.issue_id,
            body,
            doNotSubscribeToIssue: true,
          },
        },
        commentWrite,
      );
      if (result.kind !== "ok") return afterWrite(result);
      const created = result.data.commentCreate;
      return created.success &&
        isExactComment(created.comment, target.correlationId, resolved.issue_id, body)
        ? { kind: "sent", providerReplyId: target.correlationId }
        : { kind: "uncertain" };
    },
    async observe(target, signal) {
      const resolved = await readDelivery(admin, target, signal);
      if (!resolved) return { kind: "credential_unavailable" };
      if (target.message.operation === "edit") return { kind: "inconclusive" };
      const request = providerRequests(
        decryptSecretValue(resolved.encrypted_api_key),
        fetcher,
        signal,
      );
      if (target.message.operation === "linear_status") {
        return statusNotice.safeParse(target.message.content).success
          ? observeStatus(request, resolved)
          : { kind: "inconclusive" };
      }

      const content = notice.safeParse(target.message.content);
      if (!content.success) return { kind: "inconclusive" };
      const scope = await request(commentScopeQuery, { id: resolved.issue_id }, commentScope);
      if (scope.kind !== "ok") return observationFailure(scope);
      if (!isExactIssue(scope.data, resolved)) return { kind: "inconclusive" };
      const result = await request(readCommentQuery, { id: target.correlationId }, commentRead);
      if (result.kind !== "ok") return observationFailure(result);
      return isExactComment(
        result.data.comment,
        target.correlationId,
        resolved.issue_id,
        renderNotice(content.data),
      )
        ? { kind: "found", providerReplyId: target.correlationId }
        : { kind: "inconclusive" };
    },
  };
}

export function reconcileLinearLinkedOutcomes(admin: Admin, fetcher: typeof fetch = fetch) {
  return drainConnectorOutboundDeliveries(admin, createLinearOutboundAdapter(admin, fetcher));
}
