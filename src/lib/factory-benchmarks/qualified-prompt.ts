import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { loadFactorySkillBundle } from "@/lib/factory-skills/runtime";
import {
  trustedPromptValue,
  untrustedPromptValue,
  verifyPromptBoundary,
  type PromptValue,
  type UntrustedPromptValue,
} from "@/lib/pipeline/prompt-safety";
import { buildStageTemplateVariables } from "@/lib/prompt-templates";
import { renderTemplate, templateVariablePaths } from "@/lib/prompt-templates/render";
import type { Database } from "@/lib/supabase/database.types";

import type { QualifiedTrialClaim } from "./qualified-trial-contracts";
import { BenchmarkReplayUnavailable, replaySha256, type ReplayPlan } from "./replay-contracts";

type ReplayEnvironment = { plan: ReplayPlan; repositoryFullName: string; baseBranch: string };

const replayInstructions = trustedPromptValue(
  "wallie.benchmarkReplayInstructions",
  "## Isolated benchmark execution\n\nWork only in the local checkout. Do not contact external services, publish source, or create or update issues, pull requests, chat messages, or deployments. Leave reviewable source changes in the checkout and return the completed deliverable as final Markdown.",
);

export async function renderQualifiedReplayPrompt({
  admin,
  trial,
  plan,
  repositoryFullName,
  baseBranch,
  signal,
}: ReplayEnvironment & {
  admin: SupabaseClient<Database>;
  trial: QualifiedTrialClaim;
  signal: AbortSignal;
}) {
  const { workspaceId, factoryId } = trial.identity;
  const { candidate } = trial;
  const { data: revision, error } = await admin
    .from("factory_definition_revisions")
    .select("definition_json,canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", candidate.definitionRevisionId)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (error || revision?.canonical_digest !== candidate.definitionDigest)
    throw new BenchmarkReplayUnavailable("The selected factory definition is unavailable.");

  const definition = readVerifiedFactoryDefinition(
    revision.definition_json,
    candidate.definitionDigest,
  );
  const source = readVerifiedFactoryDefinition(
    plan.text.definitionJson,
    plan.identity.definitionDigest,
  );
  const stage = definition?.stages.find(({ id }) => id === plan.runtime.stageId);
  const originalStage = source?.stages.find(({ id }) => id === plan.runtime.stageId);
  if (
    !definition ||
    !source ||
    !stage ||
    !originalStage ||
    stage.slug !== originalStage.slug ||
    definition.pipelineId !== source.pipelineId ||
    definition.repositoryId !== plan.identity.repositoryId ||
    definition.sandboxProvider !== "vercel" ||
    definition.mcpManifest?.servers.length ||
    plan.readRepositories.size ||
    definition.readContextRepositoryIds?.length ||
    JSON.stringify(definition.contextDocuments ?? []) !==
      JSON.stringify(source.contextDocuments ?? []) ||
    (plan.text.documents.length > 0 &&
      JSON.stringify(definition.executionGrant) !== JSON.stringify(source.executionGrant))
  )
    throw new BenchmarkReplayUnavailable(
      "The selected factory definition cannot use these captured task inputs.",
    );

  const agent = definition.implementationAgent;
  if (!agent || replaySha256(agent.promptMd) !== agent.promptSha256)
    throw new BenchmarkReplayUnavailable("The selected agent prompt failed its digest check.");
  const [promptRevision, skills] = await Promise.all([
    admin
      .from("factory_agent_prompt_revisions")
      .select("prompt_md,prompt_sha256")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("agent_id", agent.agentId)
      .eq("id", agent.promptRevisionId)
      .abortSignal(signal)
      .maybeSingle(),
    loadFactorySkillBundle(admin, {
      workspaceId,
      factoryId,
      skillRevisionIds: definition.skillIds,
      requireCurrent: true,
      signal,
    }),
  ]);
  signal.throwIfAborted();
  if (
    promptRevision.error ||
    promptRevision.data?.prompt_md !== agent.promptMd ||
    promptRevision.data.prompt_sha256 !== agent.promptSha256
  )
    throw new BenchmarkReplayUnavailable("The selected agent prompt revision is unavailable.");

  const required = new Map(plan.text.required.map(({ key, body }) => [key, body]));
  const title = required.get("session/title");
  if (
    typeof title !== "string" ||
    required.get("session/prompt") !== plan.text.originalPrompt ||
    required.size !== plan.text.required.length
  )
    throw new BenchmarkReplayUnavailable("The retained task request is unavailable.");

  const previousStages: Record<string, UntrustedPromptValue> = {};
  const predecessorIds = new Set<string>();
  let feedback: UntrustedPromptValue | null = null;
  for (const [key, body] of required) {
    if (key === "session/title" || key === "session/prompt") continue;
    const [kind, id, slug] = key.split("/");
    if (kind === "feedback" && !feedback) {
      feedback = untrustedPromptValue("attempt.feedback", body);
      continue;
    }
    if (
      kind === "predecessor" &&
      id &&
      slug &&
      presetStagePrecedes(definition.stages, stage.id, id, slug) &&
      !Object.hasOwn(previousStages, slug)
    ) {
      predecessorIds.add(id);
      previousStages[slug] = untrustedPromptValue(`artifact.previousStages.${slug}`, body);
      continue;
    }
    throw new BenchmarkReplayUnavailable(
      "A required input is unsupported by the qualified replay.",
    );
  }
  if (stage.previousStageIds.some((id) => !predecessorIds.has(id)))
    throw new BenchmarkReplayUnavailable(
      "A predecessor required by the selected stage was not captured.",
    );

  const stageSource = trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd);
  const rules = trustedPromptValue("pipeline.operatingRules", definition.operatingRulesMd);
  const sourceTemplate = [verifyPromptBoundary(rules), verifyPromptBoundary(stageSource)]
    .filter(Boolean)
    .join("\n\n");
  if (feedback && templateVariablePaths(sourceTemplate).includes("attempt.number"))
    throw new BenchmarkReplayUnavailable(
      "The selected prompt needs a historical review attempt number.",
    );

  const taskPrompt = untrustedPromptValue("session.prompt", plan.text.originalPrompt);
  const variables = buildStageTemplateVariables({
    sessionTitle: untrustedPromptValue("session.title", title),
    sessionPrompt: taskPrompt,
    stageSlug: trustedPromptValue("stage.slug", stage.slug),
    attemptNumber: 1,
    attemptFeedback: feedback,
    repoName: untrustedPromptValue(
      "repo.name",
      repositoryFullName.split("/").at(-1) ?? repositoryFullName,
    ),
    repoFullName: untrustedPromptValue("repo.fullName", repositoryFullName),
    repoDefaultBranch: untrustedPromptValue("repo.defaultBranch", baseBranch),
    previousStages,
  });
  const rendered = renderTemplate(sourceTemplate, variables);
  const context: PromptValue[] = [
    ...plan.text.documents.map(({ revisionId, body }) =>
      untrustedPromptValue(`context.document.${revisionId}`, body),
    ),
    ...plan.text.memories.map(({ revisionId, body }) =>
      untrustedPromptValue(`benchmark.memory.${revisionId}`, body),
    ),
    ...plan.text.conversation.map(({ sequence, body }) =>
      untrustedPromptValue(`conversation.message.${sequence}`, body),
    ),
  ];
  const boundTask = verifyPromptBoundary(taskPrompt);
  const prompt = [
    verifyPromptBoundary(replayInstructions),
    verifyPromptBoundary(trustedPromptValue("agent.prompt", agent.promptMd)),
    ...skills.map(verifyPromptBoundary),
    rendered,
    ...(rendered.includes(boundTask) ? [] : [boundTask]),
    ...context.map(verifyPromptBoundary),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > 256 * 1024)
    throw new BenchmarkReplayUnavailable(
      "The benchmark prompt exceeds the qualified replay limit.",
    );
  return {
    prompt,
    promptSha256: replaySha256(prompt),
    effort: definition.agent.effort ?? undefined,
  };
}

function presetStagePrecedes(
  stages: readonly { id: string; slug: string }[],
  currentId: string,
  id: string,
  slug: string,
) {
  const predecessor = stages.findIndex((stage) => stage.id === id && stage.slug === slug);
  return predecessor >= 0 && predecessor < stages.findIndex((stage) => stage.id === currentId);
}
