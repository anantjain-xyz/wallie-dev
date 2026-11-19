import {
  factoryMemoryCommandSchema,
  factoryMemoryPageSchema,
} from "@/lib/factory-memory/contracts";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";

const MAX_COMMAND_BYTES = 32 * 1024;
const memoryColumns =
  "id, workspace_id, factory_id, title, source_session_id, source_artifact_id, source_artifact_version, source_run_id, source_attempt_count, source_commit_sha, source_content_sha256, current_revision_id, pending_revision_id, current_approval_id, forgotten_at, created_at";
const revisionColumns =
  "id, workspace_id, factory_id, memory_id, revision_number, content_sha256, expires_at, supersedes_revision_id, created_at";
const decisionColumns =
  "id, workspace_id, factory_id, memory_id, revision_id, actor_member_id, action, created_at";
type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

async function readCommand(request: Request): Promise<unknown> {
  if (!request.body) return null;
  let size = 0;
  const bounded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, stream) {
        size += bytes.byteLength;
        if (size > MAX_COMMAND_BYTES) {
          stream.error(new Error("Memory command exceeded its byte limit."));
          return;
        }
        stream.enqueue(bytes);
      },
    }),
  );
  return new Response(bounded).json().catch(() => null);
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const parsed = factoryMemoryPageSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) return failure("Provide a valid factory memory query.", 400);
  const { supabase } = context.access;
  const { workspaceId, factoryId } = context;
  const page = parsed.data;
  if ("artifactId" in page) {
    const { data, error } = await supabase.rpc("has_factory_run_memory_proposal", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_artifact_id: page.artifactId,
      p_artifact_version: page.artifactVersion,
    });
    if (error) {
      return failure(
        "Could not load memory proposal availability.",
        factoryErrorStatus(error.code),
      );
    }
    return Response.json({ available: data === true }, { headers });
  }

  const scope = { workspace_id: workspaceId, factory_id: factoryId };
  const memories = supabase.from("factory_memories").select(memoryColumns).match(scope);
  if (!("memoryId" in page)) {
    const query = memories.order("id").limit(page.limit + 1);
    const { data, error } = await (page.afterId ? query.gt("id", page.afterId) : query);
    if (error) return failure("Could not load factory memories.", 500);
    const items = data.slice(0, page.limit);
    return Response.json(
      { memories: items, nextAfterId: data.length > page.limit ? items.at(-1)?.id : null },
      { headers },
    );
  }

  const familyScope = { ...scope, memory_id: page.memoryId };
  const versions = supabase
    .from("factory_memory_revisions")
    .select(revisionColumns)
    .match(familyScope)
    .order("revision_number", { ascending: false })
    .limit(page.limit + 1);
  const [memory, revisions] = await Promise.all([
    memories.eq("id", page.memoryId).maybeSingle(),
    page.beforeVersion ? versions.lt("revision_number", page.beforeVersion) : versions,
  ]);
  if (memory.error || revisions.error) return failure("Could not load factory memory.", 500);
  if (!memory.data) return failure("Factory memory not found.", 404);
  const items = revisions.data.slice(0, page.limit);
  const targetIds = items.map(({ id }) => id);
  const decisions = supabase
    .from("factory_memory_review_events")
    .select(decisionColumns)
    .match(familyScope)
    .order("created_at")
    .order("id");
  const [bodies, history] = await Promise.all([
    targetIds.length
      ? supabase
          .from("factory_memory_revision_bodies")
          .select("revision_id, body_md")
          .match(familyScope)
          .in("revision_id", targetIds)
      : { data: [], error: null },
    targetIds.length
      ? decisions.or(`revision_id.in.(${targetIds.join(",")}),revision_id.is.null`)
      : decisions.is("revision_id", null),
  ]);
  if (bodies.error || history.error) return failure("Could not load factory memory history.", 500);
  const bodyByRevision = new Map(bodies.data.map((body) => [body.revision_id, body.body_md]));
  return Response.json(
    {
      memory: memory.data,
      revisions: items.map((revision) => ({
        ...revision,
        body_md: bodyByRevision.get(revision.id) ?? null,
      })),
      decisions: history.data,
      nextBeforeVersion: revisions.data.length > page.limit ? items.at(-1)?.revision_number : null,
    },
    { headers },
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return failure("Send a JSON request body.", 415);
  }
  const parsed = factoryMemoryCommandSchema.safeParse(await readCommand(request));
  if (!parsed.success) return failure("Provide a valid factory memory command.", 400);
  const command = parsed.data;
  const { supabase } = context.access;
  const scope = { p_workspace_id: context.workspaceId, p_factory_id: context.factoryId };

  if (command.action === "propose") {
    const { data, error } = await supabase
      .rpc("propose_factory_memory", {
        ...scope,
        p_artifact_id: command.artifactId,
        p_artifact_version: command.artifactVersion,
        p_title: command.title,
        ...(command.expiresAt ? { p_expires_at: command.expiresAt } : {}),
      })
      .select(memoryColumns)
      .single();
    if (error)
      return failure("Could not import the memory proposal.", factoryErrorStatus(error.code));
    return Response.json({ memory: data }, { headers });
  }

  const args = {
    ...scope,
    p_memory_id: command.memoryId,
    ...(command.expectedCurrentRevisionId
      ? { p_expected_current_revision_id: command.expectedCurrentRevisionId }
      : {}),
    ...(command.expectedPendingRevisionId
      ? { p_expected_pending_revision_id: command.expectedPendingRevisionId }
      : {}),
  };
  const result = await (
    command.action === "correct"
      ? supabase.rpc("correct_factory_memory", {
          ...args,
          p_body_md: command.body,
          ...(command.expiresAt ? { p_expires_at: command.expiresAt } : {}),
        })
      : command.action === "review"
        ? supabase.rpc("review_factory_memory", { ...args, p_decision: command.decision })
        : supabase.rpc("forget_factory_memory", args)
  )
    .select(memoryColumns)
    .single();
  if (result.error) {
    return failure("Could not update the factory memory.", factoryErrorStatus(result.error.code));
  }
  return Response.json({ memory: result.data }, { headers });
}
