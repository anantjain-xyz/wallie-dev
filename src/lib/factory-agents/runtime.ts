import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { factoryAgentPromptSnapshotSchema, type FactoryAgentPromptSnapshot } from "./contracts";

export async function loadRunAgentPrompt(
  client: SupabaseClient<Database>,
  input: {
    workspaceId: string;
    factoryId: string;
    sessionId: string;
    runId: string;
    expected?: FactoryAgentPromptSnapshot;
  },
): Promise<FactoryAgentPromptSnapshot> {
  const { data: run, error: runError } = await client
    .from("agent_runs")
    .select("agent_id, agent_prompt_revision_id")
    .eq("workspace_id", input.workspaceId)
    .eq("session_id", input.sessionId)
    .eq("id", input.runId)
    .single();
  if (runError) throw runError;
  if (!run) throw new Error("The run's agent identity is unavailable.");

  const { data: revision, error } = await client
    .from("factory_agent_prompt_revisions")
    .select("agent_id, id, prompt_md, prompt_sha256")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .eq("agent_id", run.agent_id)
    .eq("id", run.agent_prompt_revision_id)
    .single();
  if (error) throw error;
  if (!revision) throw new Error("The run's pinned agent prompt is unavailable.");

  const snapshot = factoryAgentPromptSnapshotSchema.parse({
    agentId: revision.agent_id,
    promptRevisionId: revision.id,
    promptMd: revision.prompt_md,
    promptSha256: revision.prompt_sha256,
  });
  if (
    createHash("sha256").update(snapshot.promptMd, "utf8").digest("hex") !== snapshot.promptSha256
  ) {
    throw new Error("The run's pinned agent prompt failed integrity verification.");
  }
  if (
    input.expected &&
    (input.expected.agentId !== snapshot.agentId ||
      input.expected.promptRevisionId !== snapshot.promptRevisionId ||
      input.expected.promptMd !== snapshot.promptMd ||
      input.expected.promptSha256 !== snapshot.promptSha256)
  ) {
    throw new Error("The run's agent prompt differs from its pinned factory definition.");
  }
  return snapshot;
}
