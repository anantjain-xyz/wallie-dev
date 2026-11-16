import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

import { compiledFactoryDefinitionSchema } from "./schema";
import { parseFactoryDefinitionJson } from "./serialization";
import { selectDefaultFactory } from "./storage";

type DefinitionClient = Pick<SupabaseClient<Database>, "from">;
type SessionPin = Pick<
  Tables<"sessions">,
  "workspace_id" | "factory_definition_revision_id" | "execute_pinned_definition"
>;

export async function loadPinnedFactoryExecution(client: DefinitionClient, session: SessionPin) {
  if (!session.execute_pinned_definition) return null;
  if (!session.factory_definition_revision_id) throw new Error("Session has no factory revision.");
  return loadExecutionRevision(
    client,
    session.workspace_id,
    session.factory_definition_revision_id,
  );
}

export async function loadActiveFactoryExecution(client: DefinitionClient, workspaceId: string) {
  const { data: factory, error: factoryError } = await selectDefaultFactory(client, workspaceId);
  if (factoryError) throw factoryError;
  if (!factory) return null;

  const { data: activation, error: activationError } = await client
    .from("factory_definition_activations")
    .select("revision_id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .order("activation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activationError) throw activationError;
  return activation ? loadExecutionRevision(client, workspaceId, activation.revision_id) : null;
}

async function loadExecutionRevision(
  client: DefinitionClient,
  workspaceId: string,
  revisionId: string,
) {
  const { data, error } = await client
    .from("factory_definition_revisions")
    .select("definition_json, canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("id", revisionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The factory revision is unavailable in this workspace.");

  const digest = createHash("sha256").update(data.definition_json, "utf8").digest("hex");
  const decoded = parseFactoryDefinitionJson(data.definition_json);
  const definition = compiledFactoryDefinitionSchema.safeParse(decoded.ok ? decoded.value : null);
  if (digest !== data.canonical_digest || !definition.success) {
    throw new Error("The factory revision failed validation. Review its published configuration.");
  }
  return { ...definition.data, canonicalDigest: digest };
}

export type PinnedFactoryExecution = NonNullable<
  Awaited<ReturnType<typeof loadPinnedFactoryExecution>>
>;

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
