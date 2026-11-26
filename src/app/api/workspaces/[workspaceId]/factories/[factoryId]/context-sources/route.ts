import {
  contextSourceCommandSchema,
  contextSourcePageSchema,
  contextSourceSyncClaimSchema,
} from "@/lib/factory-context/contracts";
import { fetchGitHubContextFile } from "@/lib/factory-context/github-source";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 40;
const maxCommandBytes = 8 * 1024;

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

const sourceColumns =
  "id, workspace_id, factory_id, repository_id, github_installation_id, upstream_repository_id, grant_id, grant_version, file_path, status, current_revision_id, upstream_revision, upstream_updated_at, last_successful_sync_at, last_sync_attempt_at, deleted_at, created_at";

function failure(error: string, status: number, detail?: { code: string }) {
  return Response.json({ error, ...detail }, { status, headers });
}

async function readCommandBody(request: Request): Promise<unknown> {
  if (!request.body) return null;

  let received = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, stream) {
        received += bytes.byteLength;
        if (received > maxCommandBytes) {
          stream.error(new Error("Context source command exceeded its byte limit."));
          return;
        }
        stream.enqueue(bytes);
      },
    }),
  );
  return new Response(body).json().catch(() => null);
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const query = contextSourcePageSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) return failure("Invalid context source list request.", 400);

  const { afterId, limit } = query.data;
  let page = context.access.supabase
    .from("factory_context_sources")
    .select(sourceColumns)
    .eq("workspace_id", context.workspaceId)
    .eq("factory_id", context.factoryId)
    .order("id")
    .limit(limit + 1);
  if (afterId) page = page.gt("id", afterId);
  const { data, error } = await page;
  if (error) return failure("Could not load context sources.", 500);
  const sources = data.slice(0, limit);
  return Response.json(
    { sources, nextAfterId: data.length > limit ? sources.at(-1)?.id : null },
    { headers },
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return failure("Send a JSON request body.", 415);
  }
  const parsed = contextSourceCommandSchema.safeParse(await readCommandBody(request));
  if (!parsed.success) return failure("Provide a valid context source command.", 400);

  const command = parsed.data;
  const admin = createSupabaseAdminClient();
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };

  if (command.action === "register") {
    const { data, error } = await admin
      .rpc("register_factory_context_source", {
        ...actor,
        p_repository_id: command.repositoryId,
        p_grant_id: command.grantId,
        p_grant_version: command.grantVersion,
        p_file_path: command.filePath,
      })
      .select(sourceColumns)
      .single();
    if (error?.code === "PT409") {
      const scope = { workspace_id: context.workspaceId, factory_id: context.factoryId };
      const viewer = context.access.supabase;
      const repository = await viewer
        .from("github_repositories")
        .select("repo_id")
        .match({ ...scope, id: command.repositoryId })
        .maybeSingle();
      const existing =
        !repository.error && repository.data
          ? await viewer
              .from("factory_context_sources")
              .select("id")
              .match({
                ...scope,
                upstream_repository_id: repository.data.repo_id,
                file_path: command.filePath,
              })
              .is("deleted_at", null)
              .maybeSingle()
          : null;
      return Response.json(
        {
          code: "registration_conflict",
          error:
            "That path already has a source under a different connection or grant. Review that source before registering it again.",
          ...(existing?.data && !existing.error ? { existingSourceId: existing.data.id } : {}),
        },
        { status: 409, headers },
      );
    }
    if (error?.code === "42501")
      return failure(
        "Could not register under this grant. Check factory access and the repository’s read grant in Governance.",
        403,
        { code: "registration_access_unavailable" },
      );
    if (error?.code === "P0011")
      return failure("This factory is archived and cannot register sources.", 409);
    if (error)
      return failure("Could not register the context source.", factoryErrorStatus(error.code));
    return Response.json({ source: data }, { headers });
  }

  const sourceInput = { ...actor, p_source_id: command.sourceId };
  if (command.action === "remove") {
    const { data, error } = await admin
      .rpc("delete_factory_context_source", sourceInput)
      .select(sourceColumns)
      .single();
    if (error)
      return failure("Could not remove the context source.", factoryErrorStatus(error.code));
    return Response.json({ source: data }, { headers });
  }

  const { data: claim, error: claimError } = await admin
    .rpc("claim_factory_context_source_sync", sourceInput)
    .single();
  if (claimError) {
    if (claimError.code === "PT409")
      return failure("A sync is already running. Wait for it to finish, then refresh.", 409, {
        code: "sync_in_progress",
      });
    if (claimError.code === "P0011")
      return failure("This factory is archived and cannot sync sources.", 409, {
        code: "factory_archived",
      });
    if (claimError.code === "P0002")
      return failure("This source is unavailable. Return to All sources.", 404, {
        code: "source_unavailable",
      });
    return failure("Could not start the context sync.", factoryErrorStatus(claimError.code));
  }
  const validatedClaim = contextSourceSyncClaimSchema.safeParse(claim);
  if (!validatedClaim.success) return failure("Could not resolve the context sync claim.", 500);
  const sync = validatedClaim.data;
  if (sync.status !== "syncing") {
    return Response.json(
      {
        sourceId: command.sourceId,
        status: sync.status,
        code: sync.status,
        error:
          sync.status === "deleted"
            ? "This source was removed. Return to All sources."
            : "This source’s exact grant or repository connection is unavailable. Review access in Governance.",
      },
      { status: sync.status === "deleted" ? 410 : 403, headers },
    );
  }

  const result = await fetchGitHubContextFile({
    installationId: sync.installation_id,
    repositoryId: sync.repository_id,
    repositoryFullName: sync.repository_full_name,
    filePath: sync.file_path,
  });
  const { data, error } = await admin
    .rpc("settle_factory_context_source_sync", {
      ...sourceInput,
      p_lease_id: sync.lease_id,
      p_status: result.status,
      ...(result.status === "synced"
        ? {
            p_content: result.content,
            p_upstream_revision: result.upstreamRevision,
            p_upstream_updated_at: result.upstreamUpdatedAt,
          }
        : {}),
    })
    .select(sourceColumns)
    .single();
  if (error) {
    const status = factoryErrorStatus(error.code);
    if (status === 409 || status === 404)
      return failure(
        "The sync result could not be recorded. Refresh before trying again.",
        status,
        {
          code: "sync_result_unavailable",
        },
      );
    return failure("Could not record the context sync outcome.", status);
  }
  return Response.json({ source: data }, { headers });
}
