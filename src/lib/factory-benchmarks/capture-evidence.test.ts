import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitHubResourceReader,
  verifyLiveGitHubContextRevision,
} from "@/lib/factory-context/github-source";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

import { loadBenchmarkSource, verifyBenchmarkGitStart } from "./capture-evidence";
import { resolveBenchmarkCapture, saveBenchmarkCapture } from "./capture";

vi.mock(import("@/lib/factory-context/github-source"), async (importOriginal) => ({
  ...(await importOriginal()),
  createGitHubResourceReader: vi.fn(),
  verifyLiveGitHubContextRevision: vi.fn(),
}));

const id = (suffix: number) => "61200000-0000-4000-8000-" + String(suffix).padStart(12, "0");
const workspaceId = id(1);
const factoryId = id(2);
const sessionId = id(3);
const runId = id(4);
const jobId = id(5);
const definitionId = id(6);
const repositoryId = id(7);
const sourceId = id(8);
const revisionId = id(9);
const originalTitle = "Original request title";
const originalPrompt = "Use the original requirements.";
const inputSha = "a".repeat(40);
const inputRef = "refs/heads/wallie-retained/base";
const definitionDigest = "b".repeat(64);
const recordedPrompt = "c".repeat(64);
const contextDigest = "d".repeat(64);
const documentDigest = "e".repeat(64);
const repository = {
  repositoryId: 45,
  installationId: 12,
  repositoryFullName: "fixture/repository",
};
const reader = vi.fn<Awaited<ReturnType<typeof createGitHubResourceReader>>>();
const encoder = new TextEncoder();

function fixture({
  documentAccess = "available",
  role = "owner",
  attachedImage = false,
}: { documentAccess?: string; role?: "owner" | "member"; attachedImage?: boolean } = {}) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const selectedDocument = {
    sourceId,
    revisionId,
    status: "selected",
    reason: "exact_revision",
    filePath: "docs/proof.md",
    upstreamRevision: inputSha,
    contentSha256: documentDigest,
    contentBytes: 5,
    stale: false,
    sha256: documentDigest,
    utf8Bytes: 5,
  };
  const manifest = {
    version: 1,
    required: [
      { key: "session/title", ...fingerprintRunContextInput(originalTitle) },
      { key: "session/prompt", ...fingerprintRunContextInput(originalPrompt) },
    ],
    documents: [selectedDocument],
    conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
    budget: {
      maxUtf8Bytes: 100,
      maxEstimatedTokens: 100,
      usedUtf8Bytes: 5 + Buffer.byteLength(originalTitle) + Buffer.byteLength(originalPrompt),
      estimatedTokens: 5 + Buffer.byteLength(originalTitle) + Buffer.byteLength(originalPrompt),
    },
  };
  const run = {
    id: runId,
    session_id: sessionId,
    agent_job_id: jobId,
    attempt_count: 2,
    status: "success" as const,
    finished_at: "2026-11-20T03:00:00.000Z",
    sessions: { factory_id: factoryId },
  };
  let saves = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(
      typeof request === "string" || request instanceof URL ? request : request.url,
    );
    const path = url.pathname.split("/").at(-1) ?? "";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ path, body });
    if (path === "list_factory_context_source_access") {
      expect(body).toEqual({
        target_workspace_id: workspaceId,
        target_factory_id: factoryId,
        target_source_ids: [sourceId],
      });
      return Response.json([{ source_id: sourceId, status: documentAccess }]);
    }
    if (path === "capture_factory_benchmark_run") {
      return Response.json({
        taskId: id(10),
        taskRevisionId: id(11),
        suiteId: id(12),
        suiteRevisionId: id(13),
        added: saves++ === 0,
      });
    }
    expect(url.searchParams.get("workspace_id")).toBe("eq." + workspaceId);
    if (path === "agent_runs") return Response.json(run);
    if (path === "factories") return Response.json({ status: "active", factory_members: [] });
    if (path === "session_attachments") {
      expect(url.searchParams.get("session_id")).toBe("eq." + sessionId);
      expect(url.searchParams.get("status")).toBe("eq.attached");
      return Response.json(attachedImage ? [{ id: id(18) }] : []);
    }
    if (path === "session_factory_admission_inputs") {
      expect(url.searchParams.get("factory_id")).toBe("eq." + factoryId);
      return Response.json({
        original_title: originalTitle,
        original_prompt_md: originalPrompt,
        prompt_sha256: createHash("sha256").update(originalPrompt).digest("hex"),
        definition_revision_id: definitionId,
        definition_digest: definitionDigest,
      });
    }
    if (path === "session_attempt_manifests" || path === "session_run_context_manifests") {
      expect(url.searchParams.get("attempt_count")).toBe("eq.2");
      expect(url.searchParams.get("job_id")).toBe("eq." + jobId);
      expect(url.searchParams.get("run_id")).toBe("eq." + runId);
      expect(url.searchParams.get("session_id")).toBe("eq." + sessionId);
      return Response.json(
        path === "session_attempt_manifests"
          ? {
              repository_id: repositoryId,
              input_ref: inputRef,
              input_sha: inputSha,
              checkout_sha: inputSha,
              retry_source_run_id: null,
              definition_revision_id: definitionId,
              definition_digest: definitionDigest,
              prompt_sha256: recordedPrompt,
            }
          : { manifest, manifest_sha256: contextDigest },
      );
    }
    if (path === "github_repositories") {
      return Response.json({
        repo_id: repository.repositoryId,
        full_name: repository.repositoryFullName,
        github_installation_id: id(14),
        github_installations: {
          installation_id: repository.installationId,
          suspended: false,
          workspace_id: workspaceId,
        },
      });
    }
    if (path === "factory_context_sources") {
      return Response.json([
        {
          id: sourceId,
          repository_id: repositoryId,
          github_installation_id: id(14),
          upstream_repository_id: repository.repositoryId,
          file_path: selectedDocument.filePath,
        },
      ]);
    }
    if (path === "factory_context_source_revisions") {
      return Response.json([
        {
          id: revisionId,
          source_id: sourceId,
          upstream_revision: inputSha,
          content_sha256: documentDigest,
        },
      ]);
    }
    throw new Error("Unexpected fixture request " + url.pathname);
  });
  const admin = createClient<Database>("https://benchmark.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  const access: WorkspaceAccessContext = {
    supabase: admin,
    currentMember: { id: id(15), role, kind: "human", is_active: true },
    user: { id: id(16) },
    workspace: { id: workspaceId, slug: "benchmark", name: "Benchmark", avatar_path: null },
  };
  return { scope: { access, admin, factoryId, run }, requests };
}

describe("historical benchmark capture", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createGitHubResourceReader).mockResolvedValue(reader);
    reader.mockResolvedValue(
      encoder.encode(JSON.stringify({ ref: inputRef, object: { type: "commit", sha: inputSha } })),
    );
    vi.mocked(verifyLiveGitHubContextRevision).mockResolvedValue({
      status: "verified",
      currentContentSha256: documentDigest,
    });
  });

  it("checks the exact retained ref and never falls back to a commit or current branch if it is missing", async () => {
    reader.mockRejectedValueOnce(new Error("Not found"));
    await expect(
      verifyBenchmarkGitStart(repository, { input_ref: inputRef, input_sha: inputSha }),
    ).resolves.toBe("unavailable");
    expect(reader.mock.calls.map(([path]) => path)).toEqual(["git/ref/heads/wallie-retained/base"]);
  });

  it("marks a historical run ineligible when its retained ref moves", async () => {
    reader.mockResolvedValueOnce(
      encoder.encode(
        JSON.stringify({ ref: inputRef, object: { type: "commit", sha: "0".repeat(40) } }),
      ),
    );
    const { scope } = fixture();
    const result = await loadBenchmarkSource(scope);
    expect(result).toMatchObject({
      checkoutSha: inputSha,
      originalPrompt,
      recordedPromptSha: recordedPrompt,
      contextManifestSha: contextDigest,
      eligibility: {
        status: "ineligible",
        reasons: ["The exact starting source reference is missing or changed."],
      },
    });
  });

  it("fails closed when current source access is revoked even though the recorded manifest is retained", async () => {
    const { scope } = fixture({ documentAccess: "access_revoked" });
    const result = await loadBenchmarkSource(scope);
    expect(result).toMatchObject({
      contextManifestSha: contextDigest,
      eligibility: {
        status: "ineligible",
        reasons: ["Current access to a recorded context document was revoked."],
      },
    });
    expect(verifyLiveGitHubContextRevision).not.toHaveBeenCalled();
  });

  it("denies an ordinary factory viewer before reading any privileged run evidence", async () => {
    const { scope, requests } = fixture({ role: "member" });
    await expect(resolveBenchmarkCapture(scope.access, runId)).rejects.toMatchObject({
      status: 403,
    });
    expect(requests.map(({ path }) => path)).toEqual(["agent_runs", "factories"]);
  });

  it("reports that a historical image cannot be verified without its original integrity receipt", async () => {
    const { scope } = fixture({ attachedImage: true });
    const result = await loadBenchmarkSource(scope);
    expect(result.eligibility).toEqual({
      status: "ineligible",
      reasons: ["The original session image inputs do not have a retained integrity receipt."],
    });
  });

  it("passes the reviewed task revision when adding a previously captured task", async () => {
    const { scope, requests } = fixture();
    await saveBenchmarkCapture(scope, {
      expectedTaskRevisionId: id(11),
      suite: { kind: "existing", id: id(12), revisionId: id(17) },
    });
    expect(
      requests.find(({ path }) => path === "capture_factory_benchmark_run")?.body,
    ).toMatchObject({ p_expected_task_revision_id: id(11), p_acceptance_criteria: "" });
  });

  it("returns the same receipt for a duplicate request and sends only server-derived eligibility", async () => {
    const { scope, requests } = fixture();
    const request = {
      acceptanceCriteria: "Prove behavior.",
      suite: { kind: "existing" as const, id: id(12), revisionId: id(17) },
    };
    const saved = await saveBenchmarkCapture(scope, request);
    const duplicate = await saveBenchmarkCapture(scope, request);
    expect(saved.added).toBe(true);
    expect(duplicate).toEqual({ ...saved, added: false });
    const captures = requests.filter(({ path }) => path === "capture_factory_benchmark_run");
    expect(captures[0].body).toEqual({
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: scope.access.user.id,
      p_acceptance_criteria: request.acceptanceCriteria,
      p_expected_revision_id: request.suite.revisionId,
      p_replay_eligibility: "eligible",
      p_source_run_id: runId,
      p_suite_id: request.suite.id,
      p_task_name: originalTitle,
    });
    expect(captures[1].body).toEqual(captures[0].body);
  });
});
