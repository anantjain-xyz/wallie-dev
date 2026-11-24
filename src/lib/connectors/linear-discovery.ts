import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { LINEAR_GRAPHQL_ENDPOINT } from "@/lib/linear/client";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

type Admin = Pick<SupabaseClient<Database>, "rpc">;

const pageSize = 20;
const taskLimit = 4;
const sweepTimeoutMs = 10_000;

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

const nodeId = z.object({ id: uuid });
const issueSchema = z.object({
  id: uuid,
  identifier: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*-\d+$/)
    .max(80),
  url: z.string().max(2048),
  title: z.string().min(1),
  description: z.string().nullable(),
  team: nodeId,
  project: nodeId.nullable(),
  state: nodeId,
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

class DiscoveryRateLimit extends Error {}

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
    signal,
  });
  if (response.status === 429) throw new DiscoveryRateLimit();
  const payload = responseSchema.parse(await response.json());
  if (payload.errors?.some((error) => error.extensions?.code === "RATELIMITED")) {
    throw new DiscoveryRateLimit();
  }
  if (!response.ok || payload.errors?.length) {
    throw new Error("Linear issue discovery query failed.");
  }
  const { organization, viewer, issues } = pageSchema.parse(payload.data);
  if (organization.id !== task.externalTenantId) {
    throw new Error("Linear issue discovery returned a different tenant.");
  }
  if (task.serviceActorId !== null && viewer.id !== task.serviceActorId) {
    throw new Error("Linear issue discovery returned a different service actor.");
  }
  const next = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  if (issues.pageInfo.hasNextPage && (!next || next === task.cursorPosition)) {
    throw new Error("Linear issue discovery cursor did not advance.");
  }

  return {
    next,
    externalViewerId: viewer.id,
    issues: issues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title.trim().slice(0, 200),
      description: issue.description?.slice(0, 19500) ?? null,
      team_id: issue.team.id,
      project_id: issue.project?.id ?? null,
      state_id: issue.state.id,
      creator_id: issue.creator?.id ?? null,
      label_ids: issue.labelIds,
    })),
  };
}

export async function reconcileLinearIssueDiscovery(
  admin: Admin,
  options: { workspaceId?: string } = {},
) {
  const signal = AbortSignal.timeout(sweepTimeoutMs);
  const throttled = new Set<string>();
  let admitted = 0;
  for (let index = 0; index < taskLimit && !signal.aborted; index++) {
    const { data, error } = await admin
      .rpc("claim_linear_issue_discovery", {
        ...(options.workspaceId === undefined ? {} : { p_workspace_id: options.workspaceId }),
        p_skip_workspace_ids: [...throttled],
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
      if (commitError)
        throw new Error("Could not commit Linear issue discovery.", { cause: commitError });
      admitted += z.number().int().nonnegative().parse(count);
    } catch (error) {
      if (error instanceof DiscoveryRateLimit) {
        throttled.add(task.workspaceId);
      } else {
        console.warn("[linear-discovery] page deferred", { resourceId: task.resourceId });
      }
    }
  }

  return { admitted, rateLimited: throttled.size > 0 };
}
