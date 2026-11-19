import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import {
  loadWorkspaceRunCatalogItem,
  RunCatalogWorkspaceUnavailableError,
  type WorkspaceRunCatalogItem,
} from "@/features/wallie/run-catalog";
import { runCatalogItemParamsSchema } from "@/features/wallie/run-catalog-contracts";
import { loadRunTranscript, RunTranscriptResetError } from "@/features/wallie/run-transcript";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";
import {
  recordedRunExecutionProfileSchema,
  type RecordedRunExecutionProfile,
} from "@/lib/factory-definitions/execution-profile-contracts";
import { factoryMcpManifestSchema } from "@/lib/factory-mcp/manifest";
import { workspaceSessionDetailPath } from "@/lib/routes";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

export type RunInspectorArtifact =
  | {
      kind: "available";
      id: string;
      stageSlug: string;
      version: number;
      createdAt: string;
      href: string;
    }
  | { kind: "none" | "unrecorded" | "unavailable" };

const runSkillRevisionsSchema = z.array(
  z
    .object({
      skillId: z.string().uuid(),
      revisionId: z.string().uuid(),
      name: z.string().min(1),
      version: z.number().int().positive(),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sourceKind: z.enum(["wallie_builtin", "manual", "repository"]),
    })
    .strict(),
);

export type RunInspectorSkills =
  | { kind: "recorded"; revisions: z.infer<typeof runSkillRevisionsSchema> }
  | { kind: "unrecorded" }
  | { kind: "unavailable" };

export type RunInspectorCredential = {
  bindingId: string;
  bindingVersion: number;
  materialRevision: number;
  servicePrincipalId: string;
  resolvedAt: string;
};

const runMcpManifestSchema = z
  .object({
    kind: z.enum(["planned", "pinned"]),
    manifest: factoryMcpManifestSchema,
  })
  .strict();

export type RunInspectorMcpManifest = z.infer<typeof runMcpManifestSchema>;

export type RunInspectorExecutionProfile =
  | { kind: "recorded"; profile: RecordedRunExecutionProfile }
  | { kind: "unrecorded" | "unavailable" };

export async function loadRunInspectorExecutionProfile({
  supabase,
  workspaceId,
  run,
}: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  run: Pick<WorkspaceRunCatalogItem, "id" | "attemptCount">;
}): Promise<RunInspectorExecutionProfile> {
  if (run.attemptCount === null) return { kind: "unrecorded" };
  const { data, error } = await supabase.rpc("get_run_execution_profile", {
    target_workspace_id: workspaceId,
    target_run_id: run.id,
    target_attempt_count: run.attemptCount,
  });
  if (error) return { kind: "unavailable" };
  if (data === null) return { kind: "unrecorded" };
  const parsed = recordedRunExecutionProfileSchema.safeParse(data);
  return parsed.success ? { kind: "recorded", profile: parsed.data } : { kind: "unavailable" };
}

export async function loadRunInspectorMcpManifest(input: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  run: Pick<WorkspaceRunCatalogItem, "id" | "attemptCount">;
}): Promise<RunInspectorMcpManifest | null> {
  const { supabase, workspaceId, run } = input;
  const { data, error } = await supabase.rpc("get_run_mcp_manifest", {
    target_workspace_id: workspaceId,
    target_run_id: run.id,
    ...(run.attemptCount === null ? {} : { target_attempt_count: run.attemptCount }),
  });
  if (error || !data) return null;
  const parsed = runMcpManifestSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export async function loadRunInspectorCredential(input: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  run: Pick<WorkspaceRunCatalogItem, "id" | "sessionId" | "attemptCount">;
}): Promise<RunInspectorCredential | null> {
  const { supabase, workspaceId, run } = input;
  if (run.attemptCount === null) return null;
  const { data, error } = await supabase
    .from("factory_run_credential_receipts")
    .select("binding_id, binding_version, material_revision, service_principal_id, resolved_at")
    .eq("workspace_id", workspaceId)
    .eq("session_id", run.sessionId)
    .eq("run_id", run.id)
    .eq("attempt_count", run.attemptCount)
    .maybeSingle();
  if (error || !data) return null;
  return {
    bindingId: data.binding_id,
    bindingVersion: data.binding_version,
    materialRevision: data.material_revision,
    servicePrincipalId: data.service_principal_id,
    resolvedAt: data.resolved_at,
  };
}

export async function loadRunInspectorSkills(input: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  run: Pick<WorkspaceRunCatalogItem, "id" | "attemptCount">;
}): Promise<RunInspectorSkills> {
  const { supabase, workspaceId, run } = input;
  if (run.attemptCount === null) return { kind: "unrecorded" };

  const { data, error } = await supabase.rpc("get_run_skill_revisions", {
    target_workspace_id: workspaceId,
    target_run_id: run.id,
    target_attempt_count: run.attemptCount,
  });
  if (error) return { kind: "unavailable" };
  if (data === null) return { kind: "unrecorded" };
  const parsed = runSkillRevisionsSchema.safeParse(data);
  return parsed.success ? { kind: "recorded", revisions: parsed.data } : { kind: "unavailable" };
}

export async function loadRunInspectorArtifact(input: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  workspaceSlug: string;
  run: Pick<WorkspaceRunCatalogItem, "id" | "attemptCount" | "sessionId" | "sessionNumber">;
}): Promise<RunInspectorArtifact> {
  const { supabase, workspaceId, workspaceSlug, run } = input;
  if (run.attemptCount === null) return { kind: "unrecorded" };

  const checkpoint = await supabase
    .from("session_git_checkpoints")
    .select("artifact_id")
    .eq("workspace_id", workspaceId)
    .eq("session_id", run.sessionId)
    .eq("run_id", run.id)
    .eq("attempt_count", run.attemptCount)
    .maybeSingle();
  if (checkpoint.error) return { kind: "unavailable" };
  if (!checkpoint.data) return { kind: "none" };

  const artifact = await supabase
    .from("session_artifacts")
    .select("id, stage_slug, version, created_at")
    .eq("workspace_id", workspaceId)
    .eq("session_id", run.sessionId)
    .eq("id", checkpoint.data.artifact_id)
    .maybeSingle();
  if (artifact.error || !artifact.data) return { kind: "unavailable" };
  return {
    kind: "available",
    id: artifact.data.id,
    stageSlug: artifact.data.stage_slug,
    version: artifact.data.version,
    createdAt: artifact.data.created_at,
    href: workspaceSessionDetailPath(workspaceSlug, run.sessionNumber, {
      artifactStage: artifact.data.stage_slug,
      artifactVersion: artifact.data.version,
      artifactId: artifact.data.id,
    }),
  };
}

export async function loadRunInspectorData(workspaceSlug: string, runId: string) {
  const { supabase, workspace } = await loadWorkspaceLayoutContext(workspaceSlug);
  if (!runCatalogItemParamsSchema.safeParse({ workspaceId: workspace.id, runId }).success) {
    notFound();
  }
  const context = { supabase, workspaceId: workspace.id, workspaceSlug: workspace.slug };
  const loadRun = () =>
    loadWorkspaceRunCatalogItem({ ...context, runId }).catch((error: unknown) => {
      if (error instanceof RunCatalogWorkspaceUnavailableError) notFound();
      throw error;
    });
  let run = await loadRun();
  if (!run) notFound();
  const transcriptInput = { supabase, workspaceId: workspace.id, runId };
  const transcript = await loadRunTranscript(transcriptInput).catch((error: unknown) => {
    if (error instanceof RunTranscriptResetError) return loadRunTranscript(transcriptInput);
    throw error;
  });
  if (!transcript) notFound();
  if (run.status !== transcript.runStatus || run.attemptCount !== transcript.attemptCount) {
    run = await loadRun();
    if (!run) notFound();
  }
  const [artifact, skills, credential, mcp, executionProfile] = await Promise.all([
    loadRunInspectorArtifact({ ...context, run }),
    loadRunInspectorSkills({ ...context, run }),
    loadRunInspectorCredential({ ...context, run }),
    loadRunInspectorMcpManifest({ ...context, run }),
    loadRunInspectorExecutionProfile({ ...context, run }),
  ]);
  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    run,
    artifact,
    skills,
    credential,
    mcp,
    executionProfile,
    transcript,
  };
}
