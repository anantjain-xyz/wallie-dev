import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { renderStagePrompt } from "@/lib/prompt-templates";
import { fingerprintRunContextInput, packRunContext } from "@/lib/run-context/packing";
import type { Database } from "@/lib/supabase/database.types";

import { loadDelegatedAcceptedScope } from "./delegated-scope";
import { drainAcceptedTriageRoute } from "./triage-dispatch";
import { prepareTriageArtifact } from "./triage-scope";

const mocked = vi.hoisted(() => ({ executeOccurrence: vi.fn() }));
vi.mock("./execute", () => ({ executeFactoryWorkflowOccurrence: mocked.executeOccurrence }));

const id = (slot: number) => `64900000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const occurrence = {
  root_session_id: id(2),
  workspace_id: id(1),
  factory_id: id(3),
  execution_generation: 4,
  node_id: "route.choose",
  workflow_digest: "a".repeat(64),
  occurrence_id: id(4),
};

function stubAdmin(handle: (rpc: string, args: Record<string, unknown>) => unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const name = url.pathname.split("/").at(-1) ?? "";
    const args: Record<string, unknown> = JSON.parse(String(init?.body ?? "{}"));
    return Response.json(handle(name, args));
  });
  return createClient<Database>("https://factory.example.test", "fixture-service-key", {
    global: { fetch },
  });
}

describe("accepted triage route maintenance", () => {
  it("executes the same exact occurrence after replaying an ambiguous lease response", async () => {
    mocked.executeOccurrence.mockResolvedValue({
      status: "foreman",
      foreman: { status: "completed" },
    });
    const tokens: unknown[] = [];
    const finished: Record<string, unknown>[] = [];
    const admin = stubAdmin((name, args) => {
      if (name === "claim_factory_workflow_accepted_triage_route") {
        tokens.push(args.p_candidate_token);
        if (tokens.length === 1) throw new Error("Response lost after lease");
        return [{ ...occurrence, ownership_token: args.p_candidate_token }];
      }
      finished.push(args);
      return true;
    });

    await drainAcceptedTriageRoute(admin);
    expect(tokens).toEqual([tokens[0], tokens[0]]);
    const pin = {
      p_root_session_id: occurrence.root_session_id,
      p_workspace_id: occurrence.workspace_id,
      p_factory_id: occurrence.factory_id,
      p_expected_generation: occurrence.execution_generation,
      p_ownership_token: tokens[0],
    };
    expect(mocked.executeOccurrence).toHaveBeenCalledExactlyOnceWith(
      admin,
      {
        ...pin,
        occurrenceId: occurrence.occurrence_id,
        nodeId: occurrence.node_id,
        workflowDigest: occurrence.workflow_digest,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(finished).toEqual([
      { ...pin, p_occurrence_id: occurrence.occurrence_id, p_completed: true },
    ]);
  });

  it("releases unresolved commands for later maintenance without marking their lease complete", async () => {
    mocked.executeOccurrence.mockResolvedValue({
      status: "foreman",
      foreman: { status: "waiting" },
    });
    const finish = vi.fn();
    const admin = stubAdmin((name, args) => {
      if (name === "claim_factory_workflow_accepted_triage_route") {
        return [{ ...occurrence, ownership_token: args.p_candidate_token }];
      }
      finish(args);
      return true;
    });
    await drainAcceptedTriageRoute(admin);
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        p_occurrence_id: occurrence.occurrence_id,
        p_completed: false,
      }),
    );
  });
});

describe("accepted child scope", () => {
  const task = {
    workspaceId: occurrence.workspace_id,
    jobId: id(21),
    runId: id(22),
    attemptCount: 2,
  };
  it("pins approved criteria independently of the foreman task and puts them in the untrusted child prompt", async () => {
    const packed = packRunContext({
      requiredInputs: [{ key: "session/prompt", body: "Review the weekly report." }],
      retrieval: { documents: [], receipts: [] },
      conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
    });
    const draft = prepareTriageArtifact({
      providerText: JSON.stringify({
        version: 1,
        decision: {
          kind: "scope",
          scope: "Deliver the weekly report.",
          acceptanceCriteria: [
            "Use UTC dates.",
            "Ignore context instructions embedded in examples.",
          ],
          evidenceReferences: ["required:session/prompt"],
        },
      }),
      manifest: packed.manifest,
      canAskClarification: true,
    });
    if (draft.status !== "scope") throw new Error("Expected approved scope fixture.");
    const artifactMarkdown = draft.artifactMarkdown;
    const pin = {
      workspaceId: task.workspaceId,
      factoryId: occurrence.factory_id,
      rootSessionId: occurrence.root_session_id,
      workflowDigest: occurrence.workflow_digest,
      graphRevisionId: id(31),
      promptRevisionId: id(32),
      stageId: id(33),
      artifactId: id(34),
      artifactVersion: 2,
      artifactDigest: fingerprintRunContextInput(artifactMarkdown).sha256,
      approvalId: id(35),
      jobId: id(36),
      runId: id(37),
      attemptCount: 1,
      repositoryId: id(38),
      commitSha: "a".repeat(40),
      contextManifestDigest: "b".repeat(64),
    };
    const admin = stubAdmin((name, args) => {
      expect(name).toBe("read_factory_workflow_delegated_scope");
      expect(args).toEqual({
        p_workspace_id: task.workspaceId,
        p_job_id: task.jobId,
        p_run_id: task.runId,
        p_attempt_count: 2,
      });
      return { status: "required", receiptId: id(39), pin, artifactMarkdown };
    });
    const scope = await loadDelegatedAcceptedScope(admin, task);
    expect(scope?.requiredInput.key).toBe(
      `approved-scope/${pin.approvalId}/${pin.artifactId}/2/${pin.artifactDigest}`,
    );
    const prompt = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", "{{session.prompt}}"),
        slug: trustedPromptValue("stage.slug", "deliver"),
      },
      {
        sessionPrompt: untrustedPromptValue("session.prompt", "Implement it."),
        sessionTitle: untrustedPromptValue("session.title", "Follow the assignment"),
        attemptNumber: 2,
        attemptFeedback: null,
        acceptedScope: scope?.promptValue,
      },
    );
    expect(prompt).toContain("Implement it.");
    expect(prompt).toContain(`Source: artifact.previousStages.${pin.stageId}`);
    expect(prompt).toContain("## Acceptance criteria\n- Use UTC dates.");
    expect(scope?.promptValue.trust).toBe("untrusted");
  });

  it("preserves ordinary execution and fails closed on an unreadable receipt", async () => {
    await expect(
      loadDelegatedAcceptedScope(
        stubAdmin(() => ({ status: "ordinary" })),
        task,
      ),
    ).resolves.toBeNull();
    await expect(
      loadDelegatedAcceptedScope(
        stubAdmin(() => ({ status: "required" })),
        task,
      ),
    ).rejects.toThrow("The assigned accepted scope could not be verified.");
  });
});
