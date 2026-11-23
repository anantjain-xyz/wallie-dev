import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import type { RunContextManifest } from "@/lib/run-context/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { eligibleTriageEvidence, prepareTriageArtifact } from "./triage-scope";

export async function isConfiguredTriageStage(
  admin: SupabaseClient<Database>,
  session: Pick<Tables<"sessions">, "id" | "workspace_id" | "factory_id">,
  stageId: string,
  signal?: AbortSignal,
) {
  const query = admin.rpc("read_factory_workflow_triage_binding", {
    p_session_id: session.id,
    p_workspace_id: session.workspace_id,
    p_factory_id: session.factory_id,
  });
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  if (data.stage_id !== stageId)
    throw new Error("The run does not match its configured triage stage.");
  return true;
}

export function triageOutputPrompt(manifest: RunContextManifest, canAskClarification: boolean) {
  return {
    instructions: trustedPromptValue(
      "wallie.specificationStagePolicy",
      [
        "Return only a JSON object with version 1 and one decision. Do not wrap the JSON in a code fence.",
        'For a well-scoped request use {"version":1,"decision":{"kind":"scope","scope":"One clear sentence","acceptanceCriteria":["A specific expected result"],"evidenceReferences":["required:session/prompt"]}}.',
        canAskClarification
          ? 'If essential details are ambiguous, use {"version":1,"decision":{"kind":"clarification","question":"One focused question?"}}.'
          : "The clarification limit is reached. Do not choose clarification or infer an unauthorized write scope.",
        'If the requested work cannot be scoped using the allowed evidence, use {"version":1,"decision":{"kind":"unsupported","reason":"A concise reason"}}.',
        "Cite only exact evidence references in the following list. Do not select routes or execution authority.",
      ].join("\n"),
    ),
    evidenceReferences: untrustedPromptValue(
      "specification.evidenceReferences",
      [...eligibleTriageEvidence(manifest)].sort().join("\n"),
    ),
  };
}

export class InvalidTriageOutcomeError extends Error {
  constructor(code: string) {
    super(`The triage role did not produce an eligible outcome (${code}).`);
    this.name = "InvalidTriageOutcomeError";
  }
}

export function renderTriageOutcome(input: {
  finalOutput: string;
  manifest: RunContextManifest;
  canAskClarification: boolean;
}) {
  const outcome = prepareTriageArtifact({
    providerText: input.finalOutput,
    manifest: input.manifest,
    canAskClarification: input.canAskClarification,
  });
  switch (outcome.status) {
    case "scope":
    case "clarification":
      return outcome.artifactMarkdown;
    case "unsupported":
      return `## Scope needs revision\n\n${outcome.reason}`;
    case "blocked":
      return new InvalidTriageOutcomeError(outcome.code);
  }
}
