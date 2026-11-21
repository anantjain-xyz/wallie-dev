import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitHubResourceReader,
  verifyLiveGitHubContextRevision,
} from "@/lib/factory-context/github-source";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { STAGE_PROMPT_RENDERER_VERSION } from "@/lib/prompt-templates";
import type { RunContextManifest } from "@/lib/run-context/contracts";
import { formatRunContextMessage } from "@/lib/run-context/conversation";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

import { replaySha256 } from "./replay-contracts";
import { resolveBenchmarkReplay } from "./replay-inputs";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock(import("@/lib/factory-context/github-source"), async (importOriginal) => ({
  ...(await importOriginal()),
  createGitHubResourceReader: vi.fn(),
  verifyLiveGitHubContextRevision: vi.fn(),
}));

const id = (suffix: number) => "61400000-0000-4000-8000-" + String(suffix).padStart(12, "0");
const workspaceId = id(1);
const factoryId = id(2);
const sessionId = id(3);
const sourceRunId = id(4);
const jobId = id(5);
const taskId = id(6);
const taskRevisionId = id(7);
const definitionId = id(8);
const stageId = id(9);
const repositoryId = id(10);
const installationId = id(11);
const documentId = id(12);
const documentRevisionId = id(13);
const grantId = id(14);
const memoryId = id(15);
const memoryRevisionId = id(16);
const memoryApprovalId = id(17);
const agentId = id(18);
const agentRevisionId = id(19);
const skillId = id(20);
const memberId = id(21);
const userId = id(22);

const commit = "a".repeat(40);
const ref = "refs/heads/wallie/checkpoints/fixture";
const originalTitle = "Refund eligibility";
const originalPrompt = "Preserve the refund decision at the recorded checkout.";
const renderedPromptSha256 = replaySha256("Full original rendered prompt");
const agentPrompt = "Follow the pinned factory instructions.";
const skill = "Check the refund contract before changing behavior.";
const content = "# Refund rules\n\nAllow refunds for returned items.\n";
const filePath = "docs/refunds.md";
const documentText = `File ${filePath}\nGit revision ${commit}\n\n${content}`;
const memoryText = "Preserve invoice audit history.";
const conversation = {
  sequence: 3,
  author_label: "Casey",
  body_md: "Include fee-only invoices.",
  body_truncated: false,
};
const conversationText = formatRunContextMessage(conversation).body;

const required = [
  { key: "session/title", ...fingerprintRunContextInput(originalTitle) },
  { key: "session/prompt", ...fingerprintRunContextInput(originalPrompt) },
];
const used = [originalTitle, originalPrompt, documentText, memoryText, conversationText].reduce(
  (sum, body) => sum + Buffer.byteLength(body),
  0,
);
const context = {
  version: 2,
  required,
  documents: [
    {
      sourceId: documentId,
      revisionId: documentRevisionId,
      status: "selected",
      reason: "exact_revision",
      filePath,
      upstreamRevision: commit,
      contentSha256: replaySha256(content),
      contentBytes: Buffer.byteLength(content),
      stale: false,
      ...fingerprintRunContextInput(documentText),
    },
  ],
  conversation: {
    throughSequence: 6,
    olderOmitted: 1,
    messages: [
      { sequence: conversation.sequence, ...fingerprintRunContextInput(conversationText) },
      { sequence: 5, reason: "context_budget" },
    ],
  },
  memories: [
    {
      memoryId,
      revisionId: memoryRevisionId,
      approvalId: memoryApprovalId,
      status: "selected",
      ...fingerprintRunContextInput(memoryText),
    },
  ],
  budget: {
    maxUtf8Bytes: 4096,
    maxEstimatedTokens: 4096,
    usedUtf8Bytes: used,
    estimatedTokens: used,
  },
} satisfies RunContextManifest;

// PostgREST supplies the database's exact JSONB text separately from parsed JSON.
const contextJson = JSON.stringify(context).replace('"version":2', '"version": 2');
const definition = {
  schemaVersion: 1,
  kind: "serial",
  pipelineId: id(23),
  repositoryId,
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: "medium",
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 0,
    maxTurns: 5,
  },
  implementationAgent: {
    agentId,
    promptRevisionId: agentRevisionId,
    promptMd: agentPrompt,
    promptSha256: replaySha256(agentPrompt),
  },
  executionPolicyRevisionId: id(24),
  deliveryPolicyRevisionId: null,
  skillIds: [skillId],
  toolIds: [],
  operatingRulesMd: "",
  operatingRuleStageIds: [],
  stages: [
    {
      id: stageId,
      slug: "implementation",
      name: "Implementation",
      promptTemplateMd: "{{session.prompt}}",
      description: "",
      anyoneCanApprove: true,
      approverMemberIds: [],
      previousStageIds: [],
    },
  ],
};
const { definitionJson, canonicalDigest } = serializeFactoryDefinition({
  ...definition,
  contextDocuments: [{ sourceId: documentId, revisionId: documentRevisionId }],
  executionGrant: { id: grantId, version: 3 },
});

const attempt = {
  repository_id: repositoryId,
  repository_full_name: "fixture/refunds",
  input_ref: ref,
  input_sha: commit,
  checkout_sha: commit,
  source_checkpoint_run_id: null,
  retry_source_run_id: null,
  definition_revision_id: definitionId,
  definition_digest: canonicalDigest,
  definition_skill_ids: [skillId],
  prompt_sha256: renderedPromptSha256,
  renderer_version: STAGE_PROMPT_RENDERER_VERSION - 1,
  stage_id: stageId,
  created_at: "2026-11-20T12:00:00.000Z",
  worker_runtime: "node",
  model_provider: "codex",
  model_name: "gpt-5.5",
  sandbox_provider: "vercel",
  sandbox_connection_revision: id(25),
  run_type: "code",
  agent_effort: "medium",
  max_turns: 5,
};
const receipt = {
  source_job_id: jobId,
  source_attempt_count: 2,
  repository_id: repositoryId,
  input_ref: ref,
  input_sha: commit,
  checkout_sha: commit,
  source_checkpoint_run_id: null,
  retry_source_run_id: null,
  retry_bundle_sha256: null,
  definition_revision_id: definitionId,
  definition_digest: canonicalDigest,
  original_prompt_sha256: replaySha256(originalPrompt),
  rendered_prompt_sha256: renderedPromptSha256,
  renderer_version: attempt.renderer_version,
  context_origin_run_id: null,
  context_manifest_sha256: replaySha256(contextJson),
};
const member = { id: memberId, role: "owner", kind: "human", is_active: true } as const;
const reader = vi.fn<Awaited<ReturnType<typeof createGitHubResourceReader>>>();

function setup(
  overrides: {
    missingReceipt?: boolean;
    secondaryRepository?: boolean;
    contextJson?: string;
    checkoutSha?: string;
    documentBody?: string;
    role?: "owner" | "member";
    worker?: boolean;
  } = {},
) {
  const state = {
    documentStatus: "available",
    replacedGrant: false,
    erased: false,
    replayAccessRevoked: false,
  };
  const paths: string[] = [];
  let retainedContext: RunContextManifest = context;
  let retainedManifestJson = contextJson;
  let retainedDefinitionJson = definitionJson;
  let retainedDefinitionDigest = canonicalDigest;
  if (overrides.secondaryRepository) {
    const textBytes = context.budget.usedUtf8Bytes - Buffer.byteLength(documentText);
    retainedContext = {
      ...context,
      documents: [],
      budget: { ...context.budget, usedUtf8Bytes: textBytes, estimatedTokens: textBytes },
    };
    retainedManifestJson = JSON.stringify(retainedContext);
    const serialized = serializeFactoryDefinition({
      ...definition,
      repositoryId: id(62),
      writableRepositoryIds: [repositoryId],
    });
    retainedDefinitionJson = serialized.definitionJson;
    retainedDefinitionDigest = serialized.canonicalDigest;
  }
  const retainedReceipt = {
    ...receipt,
    definition_digest: retainedDefinitionDigest,
    context_manifest_sha256: replaySha256(retainedManifestJson),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(
      typeof request === "string" || request instanceof URL ? request : request.url,
    );
    const table = url.pathname.split("/").at(-1) ?? "";
    const params = url.searchParams;
    const key = new Headers(init?.headers).get("apikey");
    paths.push(table);
    switch (table) {
      case "workspaces":
        expect(key).toBe("signed-in");
        expect(params.get("id")).toBe("eq." + workspaceId);
        return Response.json({ deletion_requested_at: null });
      case "workspace_members":
        expect(key).toBe("signed-in");
        expect(params.get("user_id")).toBe("eq." + userId);
        expect(params.get("workspace_id")).toBe("eq." + workspaceId);
        return Response.json({ ...member, role: overrides.role ?? member.role });
      case "factory_benchmark_task_revisions":
        expect(key).toBe(overrides.worker ? "service" : "signed-in");
        expect(params.get("workspace_id")).toBe("eq." + workspaceId);
        expect(params.get("id")).toBe("eq." + taskRevisionId);
        if (params.get("factory_id") !== "eq." + factoryId) return Response.json(null);
        return Response.json({
          task_id: taskId,
          replay_eligibility: "eligible",
          factory_benchmark_tasks: { source_run_id: sourceRunId, source_session_id: sessionId },
        });
      case "agent_runs":
        expect(params.get("id")).toBe("eq." + sourceRunId);
        return Response.json({
          id: sourceRunId,
          session_id: sessionId,
          agent_job_id: jobId,
          attempt_count: 2,
          sessions: { factory_id: factoryId },
          status: "success",
          finished_at: "2026-11-20T12:05:00.000Z",
          agent_id: agentId,
          agent_prompt_revision_id: agentRevisionId,
        });
      case "factories":
        expect(key).toBe("signed-in");
        expect(params.get("id")).toBe("eq." + factoryId);
        return Response.json({ status: "active", factory_members: [] });
      case "get_session_retained_content_erasure":
        expect(key).toBe("signed-in");
        expect(init?.body).toBe(
          JSON.stringify({
            target_workspace_id: workspaceId,
            target_session_id: sessionId,
          }),
        );
        return Response.json(state.erased ? { session_id: sessionId } : null);
      case "assert_factory_benchmark_replay_access":
        expect(key).toBe("service");
        expect(typeof init?.body === "string" ? JSON.parse(init.body) : null).toEqual({
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: userId,
          p_task_revision_id: taskRevisionId,
        });
        return state.replayAccessRevoked
          ? Response.json(
              { code: "42501", message: "Replay access has been revoked." },
              { status: 403 },
            )
          : Response.json(true);
      case "factory_benchmark_task_inputs":
        expect(key).toBe("service");
        expect(params.get("workspace_id")).toBe("eq." + workspaceId);
        expect(params.get("factory_id")).toBe("eq." + factoryId);
        expect(params.get("task_id")).toBe("eq." + taskId);
        expect(params.get("source_run_id")).toBe("eq." + sourceRunId);
        expect(params.get("source_session_id")).toBe("eq." + sessionId);
        return Response.json(overrides.missingReceipt ? null : retainedReceipt);
      case "session_attempt_manifests":
      case "session_run_context_manifests":
        expect(key).toBe("service");
        expect(params.get("workspace_id")).toBe("eq." + workspaceId);
        expect(params.get("session_id")).toBe("eq." + sessionId);
        expect(params.get("run_id")).toBe("eq." + sourceRunId);
        expect(params.get("job_id")).toBe("eq." + jobId);
        expect(params.get("attempt_count")).toBe("eq.2");
        return Response.json(
          table === "session_attempt_manifests"
            ? {
                ...attempt,
                definition_digest: retainedDefinitionDigest,
                checkout_sha: overrides.checkoutSha ?? attempt.checkout_sha,
              }
            : {
                manifest: retainedContext,
                manifest_sha256: retainedReceipt.context_manifest_sha256,
                origin_run_id: null,
                canonical: overrides.contextJson ?? retainedManifestJson,
              },
        );
      case "session_factory_admission_inputs":
        return Response.json({
          original_title: originalTitle,
          original_prompt_md: originalPrompt,
          prompt_sha256: receipt.original_prompt_sha256,
          definition_revision_id: definitionId,
          definition_digest: retainedDefinitionDigest,
          github_repository_id: repositoryId,
          execution_grant_id: overrides.secondaryRepository ? null : grantId,
          execution_grant_version: overrides.secondaryRepository ? null : 3,
        });
      case "factory_definition_revisions":
        expect(key).toBe("service");
        expect(params.get("id")).toBe("eq." + definitionId);
        return Response.json({
          definition_json: retainedDefinitionJson,
          canonical_digest: retainedDefinitionDigest,
        });
      case "github_repositories":
        expect(params.get("id")).toBe("eq." + repositoryId);
        return Response.json({
          repo_id: 73,
          full_name: attempt.repository_full_name,
          github_installation_id: installationId,
          github_installations: {
            installation_id: 57,
            suspended: false,
            workspace_id: workspaceId,
          },
        });
      case "session_attachments":
        return Response.json([]);
      case "list_factory_context_source_access":
        expect(key).toBe("signed-in");
        expect(init?.body).toBe(
          JSON.stringify({
            target_workspace_id: workspaceId,
            target_factory_id: factoryId,
            target_source_ids: [documentId],
          }),
        );
        return Response.json([{ source_id: documentId, status: state.documentStatus }]);
      case "benchmark_list_factory_context_source_access":
        expect(key).toBe("service");
        expect(typeof init?.body === "string" ? JSON.parse(init.body) : null).toEqual({
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_actor_user_id: userId,
          p_task_revision_id: taskRevisionId,
          p_source_ids: [documentId],
        });
        return Response.json([{ source_id: documentId, status: state.documentStatus }]);
      case "factory_context_sources":
        return Response.json([
          {
            id: documentId,
            repository_id: repositoryId,
            github_installation_id: installationId,
            upstream_repository_id: 73,
            file_path: filePath,
            grant_id: state.replacedGrant ? id(60) : grantId,
            grant_version: 3,
          },
        ]);
      case "factory_context_source_revisions":
        expect(key).toBe("service");
        expect(params.get("content_purged_at")).toBe("is.null");
        return Response.json([
          {
            id: documentRevisionId,
            source_id: documentId,
            upstream_revision: commit,
            content_sha256: replaySha256(content),
            content: overrides.documentBody ?? content,
          },
        ]);
      case "read_factory_memory_context":
        return Response.json([
          {
            memory_id: memoryId,
            revision_id: memoryRevisionId,
            approval_id: memoryApprovalId,
            body_md: memoryText,
            content_sha256: replaySha256(memoryText),
          },
        ]);
      case "session_conversation_messages":
        expect(params.get("sequence")).toBe(`in.(${conversation.sequence})`);
        return Response.json([conversation]);
      case "factory_skill_revisions":
        expect(params.get("id")).toBe(`in.(${skillId})`);
        return Response.json([
          {
            id: skillId,
            content_md: skill,
            content_sha256: replaySha256(skill),
            source_kind: "manual",
          },
        ]);
      case "factory_agent_prompt_revisions":
        expect(params.get("id")).toBe("eq." + agentRevisionId);
        return Response.json({
          id: agentRevisionId,
          agent_id: agentId,
          prompt_md: agentPrompt,
          prompt_sha256: replaySha256(agentPrompt),
        });
      default:
        throw new Error("Unexpected replay fixture request: " + url.pathname);
    }
  });
  function client(key: string) {
    return createClient<Database>("https://benchmark-replay.example.test", key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch },
    });
  }
  const access: WorkspaceAccessContext = {
    supabase: client("signed-in"),
    currentMember: member,
    user: { id: userId },
    workspace: { id: workspaceId, slug: "benchmark", name: "Benchmark", avatar_path: null },
  };
  const admin = client("service");
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
  const target = { factoryId, taskRevisionId, signal: AbortSignal.timeout(5000) };
  return {
    access,
    ...target,
    workerInput: { ...target, principal: { admin, workspaceId, actorUserId: userId } },
    state,
    paths,
  };
}

describe("resolving recorded benchmark inputs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createGitHubResourceReader).mockResolvedValue(reader);
    reader.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          ref,
          object: { type: "commit", sha: commit },
        }),
      ),
    );
    vi.mocked(verifyLiveGitHubContextRevision).mockResolvedValue({
      status: "verified",
      currentContentSha256: replaySha256(content),
    });
  });

  it("resolves exact retained source and text while classifying historical runtime and candidate limits", async () => {
    const { plan } = await resolveBenchmarkReplay({
      ...setup(),
      candidate: { model: "gpt-5-mini", harness: "codex", definitionDigest: "c".repeat(64) },
    });
    expect(plan.identity).toMatchObject({
      taskRevisionId,
      sourceRunId,
      checkoutSha: commit,
      inputRef: ref,
      originalPromptSha256: receipt.original_prompt_sha256,
      renderedPromptSha256,
      definitionDigest: canonicalDigest,
      contextManifestSha256: receipt.context_manifest_sha256,
    });
    expect(plan.text).toEqual({
      originalPrompt,
      definitionJson,
      contextManifestJson: contextJson,
      required: [
        { key: "session/title", body: originalTitle },
        { key: "session/prompt", body: originalPrompt },
      ],
      documents: [{ revisionId: documentRevisionId, body: documentText }],
      memories: [{ revisionId: memoryRevisionId, body: memoryText }],
      conversation: [{ sequence: conversation.sequence, body: conversationText }],
      skills: [{ revisionId: skillId, body: skill }],
      agentPrompt: { revisionId: agentRevisionId, body: agentPrompt },
    });
    expect(plan.runtime).toMatchObject({ harness: "codex", model: "gpt-5.5", worker: "node" });
    expect(plan.candidateChanges).toEqual(["model", "definitionDigest"]);
    expect(plan.limits).toEqual([
      "rendered_prompt_bytes_unavailable",
      "model_version_unverified",
      "runtime_version_unrecorded",
      "renderer_version_changed",
      "candidate_inputs_changed",
    ]);
    expect(reader).toHaveBeenCalledWith(
      "git/ref/heads/wallie/checkpoints/fixture",
      expect.any(Number),
    );
  });

  it("uses the admitted secondary repository without reading the definition's default repository", async () => {
    const { repository, plan } = await resolveBenchmarkReplay(setup({ secondaryRepository: true }));
    expect(repository.repositoryFullName).toBe("fixture/refunds");
    expect(plan.identity.checkoutSha).toBe(commit);
    expect(plan.text.documents).toEqual([]);
    expect(plan.limits).not.toContain("candidate_inputs_changed");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("restores the admitted worker's exact documents without a browser session and rechecks authorization", async () => {
    const fixture = setup({ worker: true });
    const restored = await resolveBenchmarkReplay(fixture.workerInput);
    expect(restored.plan.text.documents).toEqual([
      { revisionId: documentRevisionId, body: documentText },
    ]);
    expect(fixture.paths).toContain("benchmark_list_factory_context_source_access");
    expect(fixture.paths).not.toContain("list_factory_context_source_access");
    expect(fixture.paths).not.toContain("get_session_retained_content_erasure");
    fixture.state.replayAccessRevoked = true;
    await expect(restored.recheckAccess()).rejects.toThrow(
      "The original benchmark execution scope is no longer authorized.",
    );
  });

  it("rejects missing attempt receipts before checking upstream sources", async () => {
    const fixture = setup({ missingReceipt: true });
    await expect(resolveBenchmarkReplay(fixture)).rejects.toThrow(
      "The exact source attempt receipt is unavailable.",
    );
    expect(fixture.paths).not.toContain("session_attempt_manifests");
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects a checkout SHA that differs from the frozen attempt receipt", async () => {
    await expect(resolveBenchmarkReplay(setup({ checkoutSha: "b".repeat(40) }))).rejects.toThrow(
      "The recorded attempt does not match the benchmark receipt.",
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects a canonical context body that fails its retained digest", async () => {
    await expect(resolveBenchmarkReplay(setup({ contextJson: contextJson + " " }))).rejects.toThrow(
      "The recorded context manifest is unavailable or changed.",
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects a protected document whose stored bytes changed behind an unchanged digest", async () => {
    await expect(
      resolveBenchmarkReplay(setup({ documentBody: content + "Changed" })),
    ).rejects.toThrow("A recorded context document is missing or changed.");
  });

  it("rejects cross-factory and downgraded access before reading private receipts", async () => {
    const memberFixture = setup({ role: "member" });
    await expect(resolveBenchmarkReplay(memberFixture)).rejects.toMatchObject({ status: 403 });
    expect(memberFixture.paths).not.toContain("factory_benchmark_task_inputs");

    const otherFactory = setup();
    await expect(resolveBenchmarkReplay({ ...otherFactory, factoryId: id(61) })).rejects.toThrow(
      "The selected benchmark task revision is unavailable or ineligible.",
    );
    expect(otherFactory.paths).toEqual(["factory_benchmark_task_revisions"]);
  });

  it.each(["access_revoked", "deleted"])(
    "rechecks current document access when it is %s",
    async (status) => {
      const fixture = setup();
      const resolved = await resolveBenchmarkReplay(fixture);
      fixture.state.documentStatus = status;
      await expect(resolved.recheckAccess()).rejects.toThrow(/document.*(?:revoked|deleted)/i);
    },
  );

  it("rejects a document rebound to a new grant even when the new grant is usable", async () => {
    const fixture = setup();
    const resolved = await resolveBenchmarkReplay(fixture);
    fixture.state.replacedGrant = true;
    await expect(resolved.recheckAccess()).rejects.toThrow(
      "Current access to a recorded context document is unavailable.",
    );
  });

  it("stops before reading private inputs when the locked replay authorization rejects the request", async () => {
    const fixture = setup();
    fixture.state.replayAccessRevoked = true;
    await expect(resolveBenchmarkReplay(fixture)).rejects.toThrow(/access|authoriz/i);
    expect(fixture.paths).toContain("assert_factory_benchmark_replay_access");
    expect(fixture.paths).not.toContain("factory_benchmark_task_inputs");
    expect(fixture.paths).not.toContain("factory_context_source_revisions");
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects an erasure recorded after the initial authorization", async () => {
    const fixture = setup();
    const resolved = await resolveBenchmarkReplay(fixture);
    fixture.state.erased = true;
    await expect(resolved.recheckAccess()).rejects.toThrow(
      "The source session's retained inputs are unavailable.",
    );
  });
});
