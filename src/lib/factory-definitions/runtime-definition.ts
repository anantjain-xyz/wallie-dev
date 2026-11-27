import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

import { factoryWritableRepositoryIds } from "./repository-bindings";
import { selectFactory } from "./storage";
import { readVerifiedFactoryDefinition } from "./stored-definition";

type DefinitionClient = Pick<SupabaseClient<Database>, "from">;
type SessionPin = Pick<
  Tables<"sessions">,
  "workspace_id" | "factory_definition_revision_id" | "execute_pinned_definition"
>;

export async function loadPinnedFactoryExecution(
  client: DefinitionClient,
  session: SessionPin,
  signal?: AbortSignal,
) {
  if (!session.execute_pinned_definition) return null;
  if (!session.factory_definition_revision_id) throw new Error("Session has no factory revision.");
  return loadExecutionRevision(
    client,
    session.workspace_id,
    session.factory_definition_revision_id,
    signal,
  );
}

export async function loadActiveFactoryExecution(
  client: DefinitionClient,
  workspaceId: string,
  factoryId?: string,
) {
  const { data: factory, error: factoryError } = await selectFactory(
    client,
    workspaceId,
    factoryId,
  );
  if (factoryError) throw factoryError;
  if (!factory) return null;

  const { data: activation, error: activationError } = await client
    .from("factory_definition_activations")
    .select("revision_id, activation_number")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .order("activation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activationError) throw activationError;
  if (!activation) return null;
  const execution = await loadExecutionRevision(client, workspaceId, activation.revision_id);
  return { ...execution, factoryId: factory.id, activationNumber: activation.activation_number };
}

async function loadExecutionRevision(
  client: DefinitionClient,
  workspaceId: string,
  revisionId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const revision = client
    .from("factory_definition_revisions")
    .select("definition_json, canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("id", revisionId);
  const { data, error } = await (signal ? revision.abortSignal(signal) : revision).maybeSingle();
  signal?.throwIfAborted();
  if (error) throw error;
  if (!data) throw new Error("The factory revision is unavailable in this workspace.");

  const definition = readVerifiedFactoryDefinition(data.definition_json, data.canonical_digest);
  if (!definition) {
    throw new Error("The factory revision failed validation. Review its published configuration.");
  }
  return { ...definition, canonicalDigest: data.canonical_digest };
}

export type PinnedFactoryExecution = NonNullable<
  Awaited<ReturnType<typeof loadPinnedFactoryExecution>>
>;

export async function loadPinnedFactoryRepositoryId(
  client: DefinitionClient,
  session: SessionPin & Pick<Tables<"sessions">, "id" | "factory_id" | "github_repository_id">,
  definition: Pick<PinnedFactoryExecution, "repositoryId" | "writableRepositoryIds">,
): Promise<string> {
  const { data: admission, error } = await client
    .from("session_factory_admission_inputs")
    .select("github_repository_id, definition_revision_id")
    .eq("workspace_id", session.workspace_id)
    .eq("factory_id", session.factory_id)
    .eq("session_id", session.id)
    .maybeSingle();
  if (error) throw error;

  // The live FK can be cleared by GitHub disconnection. Preserve the identity
  // in the original receipt so neither the live FK nor the default retargets it.
  const repositoryId = admission ? admission.github_repository_id : session.github_repository_id;
  if (
    (admission && admission.definition_revision_id !== session.factory_definition_revision_id) ||
    !repositoryId ||
    !factoryWritableRepositoryIds(definition).includes(repositoryId)
  ) {
    throw new Error("The factory session's writable repository is unavailable.");
  }
  return repositoryId;
}

export async function loadPinnedSessionPrompt(
  client: DefinitionClient,
  session: Pick<Tables<"sessions">, "id" | "workspace_id" | "factory_definition_revision_id">,
) {
  const { data, error } = await client
    .from("session_factory_admission_inputs")
    .select("original_title, original_prompt_md, definition_revision_id")
    .eq("workspace_id", session.workspace_id)
    .eq("session_id", session.id)
    .maybeSingle();
  if (error) throw error;
  if (
    !data?.original_title ||
    !data.original_prompt_md ||
    data.definition_revision_id !== session.factory_definition_revision_id
  ) {
    throw new Error("The factory session's original prompt is unavailable.");
  }
  return { title: data.original_title, promptMd: data.original_prompt_md };
}
