import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { LINEAR_GRAPHQL_ENDPOINT, linearRetryAfterSeconds } from "@/lib/linear/client";
import { currentLinearStateSpan, linearInstant, linearStateSpan } from "@/lib/linear/state-spans";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import type { LinearDiscoveryFailureReason } from "./diagnostics-contracts";

type Admin = Pick<SupabaseClient<Database>, "rpc">;

const pageSize = 20;
const taskLimit = 4;
const sweepTimeoutMs = 10_000;
const discoveryWriteTimeoutMs = 4_000;

const uuid = z.uuid().toLowerCase();
const revision = z.number().int().positive();
const cursor = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{Cc}]+$/u);
const discoveryTask = z.object({
  workspaceId: uuid,
  factoryId: uuid,
  resourceId: uuid,
  configRevision: revision,
  resourceKind: z.enum(["team", "project"]),
  externalResourceId: uuid,
  externalTenantId: uuid,
  installationGeneration: revision,
  mappingRevision: revision,
  cursorGeneration: z.number().int().nonnegative(),
  cursorPosition: cursor.nullable(),
  stateIds: z.array(uuid).min(1).max(20),
  labelId: uuid.nullable(),
  serviceActorId: uuid.nullable(),
  encryptedApiKey: z.string().min(1),
});
type DiscoveryTask = z.output<typeof discoveryTask>;

const discoveryFailureFence = z.object({
  credentialRef: uuid,
  credentialMaterialRevision: revision,
  claimExpiresAt: linearInstant,
});

const nodeId = z.object({ id: uuid });
const issueIdentifier = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*-\d+$/)
  .max(80);
const issueSchema = z.object({
  id: uuid,
  identifier: issueIdentifier,
  previousIdentifiers: z.array(issueIdentifier),
  updatedAt: linearInstant,
  url: z.string().max(2048),
  title: z.string().min(1),
  description: z.string().nullable(),
  team: nodeId,
  project: nodeId.nullable(),
  state: nodeId,
  stateHistory: z.object({ nodes: z.array(linearStateSpan).max(1) }),
  creator: nodeId.nullable(),
  labelIds: z.array(uuid),
});
const pageSchema = z.object({
  organization: nodeId,
  viewer: nodeId,
  issues: z.object({
    nodes: z.array(issueSchema).max(pageSize),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: cursor.nullable() }),
  }),
});
const responseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() }))
    .optional(),
});

const discoveryQuery = /* GraphQL */ `
  query WallieIssueDiscovery($first: Int!, $after: String, $filter: IssueFilter!) {
    organization {
      id
    }
    viewer {
      id
    }
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        identifier
        previousIdentifiers
        updatedAt
        url
        title
        description
        team {
          id
        }
        project {
          id
        }
        state {
          id
        }
        stateHistory(last: 1) {
          nodes {
            id
            stateId
            startedAt
            endedAt
          }
        }
        creator {
          id
        }
        labelIds
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

class DiscoveryRateLimit extends Error {
  readonly retryAfterSeconds: number;

  constructor(response: Response) {
    super("Linear issue discovery reached a provider rate limit.");
    this.retryAfterSeconds = linearRetryAfterSeconds(response);
  }
}

class DiscoveryFailure extends Error {
  constructor(readonly reason: LinearDiscoveryFailureReason) {
    super("Linear issue discovery could not finish.");
  }
}

function truncateIssueText(value: string, limit: number) {
  const lastCodePoint = value.codePointAt(limit - 1) ?? 0;
  const end = lastCodePoint > 0xffff ? limit - 1 : limit;
  return value.slice(0, end).replace(/[\u0000\uD800-\uDFFF]/gu, "�");
}

async function fetchDiscoveryPage(task: DiscoveryTask, signal: AbortSignal) {
  const labelFilter = task.labelId ? { id: { eq: task.labelId } } : null;
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: decryptSecretValue(task.encryptedApiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: discoveryQuery,
      variables: {
        first: pageSize,
        after: task.cursorPosition,
        filter: {
          [task.resourceKind]: { id: { eq: task.externalResourceId } },
          state: { id: { in: task.stateIds } },
          ...(labelFilter ? { labels: labelFilter } : {}),
        },
      },
    }),
    redirect: "manual",
    signal,
  });
  if (response.status === 429) throw new DiscoveryRateLimit(response);
  if (response.status >= 300 && response.status < 400)
    throw new DiscoveryFailure("invalid_provider_response");
  if (response.status === 401 || response.status === 403)
    throw new DiscoveryFailure("provider_access_denied");
  if (response.status >= 500) throw new DiscoveryFailure("provider_unavailable");

  const body = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new DiscoveryFailure("invalid_provider_response");
  }
  const payload = responseSchema.safeParse(parsedBody);
  if (!payload.success) throw new DiscoveryFailure("invalid_provider_response");
  const errors = payload.data.errors;
  if (errors?.some((error) => error.extensions?.code === "RATELIMITED"))
    throw new DiscoveryRateLimit(response);
  if (
    errors?.length &&
    errors.every((error) => {
      const code = error.extensions?.code;
      return code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN";
    })
  )
    throw new DiscoveryFailure("provider_access_denied");
  if (!response.ok || errors?.length) throw new DiscoveryFailure("invalid_provider_response");

  const page = pageSchema.safeParse(payload.data.data);
  if (!page.success) throw new DiscoveryFailure("invalid_provider_response");
  const { organization, viewer, issues } = page.data;
  if (
    organization.id !== task.externalTenantId ||
    (task.serviceActorId !== null && viewer.id !== task.serviceActorId)
  )
    throw new DiscoveryFailure("scope_mismatch");
  const next = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  if (issues.pageInfo.hasNextPage && (!next || next === task.cursorPosition))
    throw new DiscoveryFailure("invalid_provider_response");

  return {
    next,
    externalViewerId: viewer.id,
    issues: issues.nodes.map((issue) => {
      const span = currentLinearStateSpan(
        issue.stateHistory.nodes,
        issue.state.id,
        issue.updatedAt,
      );
      return {
        id: issue.id,
        identifier: issue.identifier,
        previous_identifiers: issue.previousIdentifiers,
        url: issue.url,
        title: truncateIssueText(issue.title.trim(), 200),
        description:
          issue.description === null ? null : truncateIssueText(issue.description, 19_500),
        team_id: issue.team.id,
        project_id: issue.project?.id ?? null,
        state_id: issue.state.id,
        creator_id: issue.creator?.id ?? null,
        label_ids: issue.labelIds,
        ...(span && {
          origin_span_id: span.id,
          origin_span_started_at: span.startedAt,
          origin_issue_updated_at: issue.updatedAt,
        }),
      };
    }),
  };
}

export async function reconcileLinearIssueDiscovery(
  admin: Admin,
  options: { workspaceId?: string } = {},
) {
  const signal = AbortSignal.timeout(sweepTimeoutMs);
  let rateLimited = false;
  let admitted = 0;
  for (let index = 0; index < taskLimit && !signal.aborted; index++) {
    const { data, error } = await admin
      .rpc("claim_linear_issue_discovery", {
        ...(options.workspaceId === undefined ? {} : { p_workspace_id: options.workspaceId }),
      })
      .abortSignal(signal);
    if (error) throw new Error("Could not claim Linear issue discovery.", { cause: error });
    if (data === null) break;
    const task = discoveryTask.parse(data);

    try {
      const page = await fetchDiscoveryPage(task, signal);
      const { data: count, error: commitError } = await admin
        .rpc("commit_linear_issue_discovery_page", {
          p_workspace_id: task.workspaceId,
          p_factory_id: task.factoryId,
          p_resource_id: task.resourceId,
          p_config_revision: task.configRevision,
          p_installation_generation: task.installationGeneration,
          p_mapping_revision: task.mappingRevision,
          p_cursor_generation: task.cursorGeneration,
          p_external_tenant_id: task.externalTenantId,
          p_external_viewer_id: page.externalViewerId,
          ...(page.next === null ? {} : { p_next_position: page.next }),
          p_issues: page.issues,
        })
        .abortSignal(signal);
      const committedCount = z.number().int().nonnegative().safeParse(count);
      if (commitError || !committedCount.success)
        throw new DiscoveryFailure("discovery_commit_failed");
      admitted += committedCount.data;
    } catch (error) {
      if (error instanceof DiscoveryRateLimit) {
        rateLimited = true;
        const { error: cooldownError } = await admin
          .rpc("defer_linear_issue_discovery", {
            p_workspace_id: task.workspaceId,
            p_resource_id: task.resourceId,
            p_installation_generation: task.installationGeneration,
            p_retry_after_seconds: error.retryAfterSeconds,
          })
          .abortSignal(AbortSignal.timeout(discoveryWriteTimeoutMs));
        if (cooldownError) {
          throw new Error("Could not persist Linear issue discovery cooldown.", {
            cause: cooldownError,
          });
        }
      } else {
        const reason = error instanceof DiscoveryFailure ? error.reason : "provider_unavailable";
        const fence = discoveryFailureFence.safeParse(data);
        let recordingFailed = false;
        try {
          if (fence.success && !signal.aborted) {
            const { error: recordError } = await admin
              .rpc("record_linear_issue_discovery_failure", {
                p_workspace_id: task.workspaceId,
                p_factory_id: task.factoryId,
                p_resource_id: task.resourceId,
                p_config_revision: task.configRevision,
                p_installation_generation: task.installationGeneration,
                p_mapping_revision: task.mappingRevision,
                p_cursor_generation: task.cursorGeneration,
                p_credential_ref: fence.data.credentialRef,
                p_credential_material_revision: fence.data.credentialMaterialRevision,
                p_claim_expires_at: fence.data.claimExpiresAt,
                p_reason: reason,
              })
              .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(discoveryWriteTimeoutMs)]));
            recordingFailed = recordError !== null;
          }
        } catch {
          recordingFailed = true;
        }
        console.warn(
          recordingFailed
            ? "[linear-discovery] failure record unavailable"
            : "[linear-discovery] page deferred",
          {
            resourceId: task.resourceId,
            reason,
          },
        );
      }
    }
  }

  return { admitted, rateLimited };
}
