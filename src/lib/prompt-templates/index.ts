import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionPhase } from "@/features/sessions/types";
import type { Database } from "@/lib/supabase/database.types";

import { DEFAULT_PROMPT_TEMPLATES } from "./defaults";
import { renderTemplate, type TemplateVariables } from "./render";

export { DEFAULT_PROMPT_TEMPLATES } from "./defaults";
export { renderTemplate, type TemplateVariables } from "./render";

type AdminClient = SupabaseClient<Database>;

/**
 * Load the prompt template for a workspace + phase.
 * Falls back to the built-in default if the workspace hasn't customized it.
 */
export async function loadPromptTemplate(
  admin: AdminClient,
  workspaceId: string,
  phase: SessionPhase,
): Promise<string> {
  const { data, error } = await admin
    .from("workspace_prompt_templates")
    .select("template_md")
    .eq("workspace_id", workspaceId)
    .eq("phase", phase)
    .maybeSingle();

  if (error) {
    console.error("[prompt-templates] Failed to load custom template, using default", {
      error: error.message,
      phase,
      workspaceId,
    });
  }

  return data?.template_md ?? DEFAULT_PROMPT_TEMPLATES[phase];
}

/**
 * Build the full template variables object for rendering a phase prompt.
 */
export function buildTemplateVariables(input: {
  sessionTitle: string;
  sessionPrompt: string;
  sessionPhase: SessionPhase;
  attemptNumber: number;
  attemptFeedback: string | null;
  repoName?: string;
  repoFullName?: string;
  repoDefaultBranch?: string;
  productSpec?: string | null;
  designDoc?: string | null;
}): TemplateVariables {
  return {
    session: {
      title: input.sessionTitle,
      prompt: input.sessionPrompt,
      phase: input.sessionPhase,
    },
    attempt: {
      number: input.attemptNumber,
      feedback: input.attemptFeedback ?? "",
    },
    repo: {
      name: input.repoName ?? "",
      fullName: input.repoFullName ?? "",
      defaultBranch: input.repoDefaultBranch ?? "main",
    },
    artifact: {
      productSpec: input.productSpec ?? "",
      designDoc: input.designDoc ?? "",
    },
  };
}

/**
 * Convenience: load the template, build variables, and render in one call.
 */
export async function renderPhasePrompt(
  admin: AdminClient,
  input: {
    workspaceId: string;
    phase: SessionPhase;
    sessionTitle: string;
    sessionPrompt: string;
    attemptNumber: number;
    attemptFeedback: string | null;
    repoName?: string;
    repoFullName?: string;
    repoDefaultBranch?: string;
    productSpec?: string | null;
    designDoc?: string | null;
  },
): Promise<string> {
  const template = await loadPromptTemplate(admin, input.workspaceId, input.phase);
  const variables = buildTemplateVariables({
    ...input,
    sessionPhase: input.phase,
  });
  return renderTemplate(template, variables);
}
