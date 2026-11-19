import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SpecificationPromptContext } from "@/lib/prompt-templates";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { untrustedPromptValue } from "./prompt-safety";

const CLARIFICATION_LIMIT = 3;
const PRIOR_DRAFT_CHARACTER_LIMIT = 12_000;
const LEADING_CLARIFICATION_DIRECTIVE = /^<!-- wallie-clarification: [^\r\n]* -->\r?(?:\n|$)/;

type SpecificationSession = Pick<
  Tables<"sessions">,
  "id" | "workspace_id" | "factory_id" | "current_artifact_id" | "current_artifact_version"
>;

export async function loadSpecificationPromptContext(
  admin: SupabaseClient<Database>,
  session: SpecificationSession,
  stageId: string,
): Promise<SpecificationPromptContext> {
  const { id, workspace_id: workspaceId, factory_id: factoryId } = session;
  const clarificationCount = admin
    .from("session_specification_clarifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("session_id", id)
    .eq("stage_id", stageId);
  const currentArtifactId = session.current_artifact_id;
  const version = session.current_artifact_version;
  if (!currentArtifactId) {
    const { count, error } = await clarificationCount;
    if (error || count === null) {
      throw error ?? new Error("Specification clarification history is unavailable.");
    }
    return { canAskClarification: count < CLARIFICATION_LIMIT };
  }

  const [countResult, historyResult, draftResult] = await Promise.all([
    clarificationCount,
    admin
      .from("session_specification_clarifications")
      .select("ordinal, question, answer_text")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("session_id", id)
      .eq("stage_id", stageId)
      .eq("status", "answered")
      .lt("artifact_version", version)
      .order("ordinal", { ascending: true })
      .limit(CLARIFICATION_LIMIT),
    admin
      .from("session_artifacts")
      .select("artifact_json, session:sessions!session_artifacts_session_id_fkey!inner(factory_id)")
      .eq("workspace_id", workspaceId)
      .eq("session.factory_id", factoryId)
      .eq("session_id", id)
      .eq("stage_id", stageId)
      .eq("id", currentArtifactId)
      .eq("version", version)
      .maybeSingle(),
  ]);
  const error = countResult.error ?? historyResult.error ?? draftResult.error;
  if (error) throw error;
  if (countResult.count === null || historyResult.data === null) {
    throw new Error("Specification clarification history is unavailable.");
  }
  if (typeof draftResult.data?.artifact_json !== "string") {
    throw new Error("The exact prior specification draft is unavailable.");
  }

  const draft = Array.from(
    draftResult.data.artifact_json.replace(LEADING_CLARIFICATION_DIRECTIVE, ""),
  )
    .slice(0, PRIOR_DRAFT_CHARACTER_LIMIT)
    .join("");
  const history = historyResult.data
    .flatMap(({ ordinal, question, answer_text: answer }) =>
      answer === null ? [] : [`Round ${ordinal}\nQuestion: ${question}\nAnswer: ${answer}`],
    )
    .join("\n\n");
  return {
    canAskClarification: countResult.count < CLARIFICATION_LIMIT,
    ...(draft.trim()
      ? { priorDraft: untrustedPromptValue("specification.priorDraft", draft) }
      : {}),
    ...(history
      ? {
          clarificationHistory: untrustedPromptValue("specification.clarificationHistory", history),
        }
      : {}),
  };
}
