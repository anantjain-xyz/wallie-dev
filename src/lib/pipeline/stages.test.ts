import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database, Json } from "@/lib/supabase/database.types";

import { loadAttemptPredecessors } from "./stages";

function completion(stageId: string | null, historicalSlug: string, currentSlug: string | null) {
  return {
    completion_id: `${historicalSlug}-completion`,
    stage_id: stageId,
    stage_slug: historicalSlug,
    current_stage_slug: currentSlug,
    approval_receipt_id: null,
    artifact_id: null,
    artifact_version: null,
    artifact_digest: null,
    artifact_text: null,
  };
}

function approvedCompletion(text: string) {
  return {
    ...completion("plan-id", "plan", "discovery"),
    approval_receipt_id: "approval-1",
    artifact_id: "artifact-1",
    artifact_version: 1,
    artifact_digest: createHash("sha256").update(text).digest("hex"),
    artifact_text: text,
  };
}

type CompletionRow =
  | ReturnType<typeof completion>
  | (Omit<ReturnType<typeof approvedCompletion>, "artifact_text"> & {
      artifact_text: string | null;
    });

const plan = completion("plan-id", "old-plan", "plan");
const build = completion("build-id", "old-build", "build");

function fixture(input: {
  completed: CompletionRow[];
  completionError?: string;
  artifactError?: string;
  additionalArtifacts?: Array<{ stage_id: string; version: number; artifact_json: Json }>;
}) {
  const artifacts = [
    { stage_id: "plan-id", version: 1, artifact_json: "old plan" },
    { stage_id: "plan-id", version: 2, artifact_json: "latest plan" },
    { stage_id: "build-id", version: 1, artifact_json: "obsolete downstream build" },
    { stage_id: "build-id", version: 2, artifact_json: "latest build" },
    { stage_id: "orphan-id", version: 3, artifact_json: "orphan output" },
    ...(input.additionalArtifacts ?? []),
  ];
  const reads: string[] = [];
  const admin = createClient<Database>("http://localhost:9999", "test-service-role", {
    global: {
      fetch: async (request: string | URL | Request, init?: RequestInit) => {
        const url = new URL(request instanceof Request ? request.url : request);
        reads.push(url.pathname);
        if (url.pathname.endsWith("/load_attempt_predecessor_approvals")) {
          expect(init?.body).toBe(JSON.stringify({ p_session_id: "session" }));
          return input.completionError
            ? Response.json({ message: input.completionError }, { status: 500 })
            : Response.json(input.completed);
        }
        expect(url.pathname).toBe("/rest/v1/session_artifacts");
        expect(url.searchParams.get("session_id")).toBe("eq.session");
        if (input.artifactError) {
          return Response.json({ message: input.artifactError }, { status: 500 });
        }
        const stageIds = new Set(url.searchParams.get("stage_id")?.slice(4, -1).split(","));
        return Response.json(artifacts.filter((row) => stageIds.has(row.stage_id)));
      },
    },
  });
  return { load: () => loadAttemptPredecessors(admin, "session"), reads };
}

const approvalsPath = "/rest/v1/rpc/load_attempt_predecessor_approvals";

describe("loadAttemptPredecessors", () => {
  it("uses the reviewed artifact bytes after a rename, even when a newer retained artifact exists", async () => {
    const exact = approvedCompletion("Approuvé\n");
    const { load, reads } = fixture({ completed: [exact, plan, build] });
    await expect(load()).resolves.toEqual({
      promptArtifacts: { discovery: "Approuvé\n", build: "latest build" },
      predecessors: [
        {
          status: "approved",
          stageId: "plan-id",
          stageSlug: "discovery",
          approvalReceiptId: "approval-1",
          artifactId: "artifact-1",
          artifactVersion: 1,
          artifactDigest: exact.artifact_digest,
        },
        { status: "legacy_unverified", stageId: "build-id", stageSlug: "build" },
      ],
    });
    expect(reads).toEqual([approvalsPath, "/rest/v1/session_artifacts"]);
  });

  it("rejects changed bytes or a missing artifact without reading a guessed substitute", async () => {
    const exact = approvedCompletion("Reviewed bytes");
    for (const text of [null, "Changed bytes"]) {
      const { load, reads } = fixture({ completed: [{ ...exact, artifact_text: text }] });
      await expect(load()).rejects.toThrow("does not match its approval receipt");
      expect(reads).toEqual([approvalsPath]);
    }
  });

  it("records legacy completion as unverified and excludes invalidated downstream history", async () => {
    const { load } = fixture({ completed: [plan] });
    await expect(load()).resolves.toEqual({
      promptArtifacts: { plan: "latest plan" },
      predecessors: [{ status: "legacy_unverified", stageId: "plan-id", stageSlug: "plan" }],
    });
  });

  it("records orphan labels without inferring their input text from another stage", async () => {
    const { load } = fixture({
      completed: [completion(null, "legacy", null), completion("orphan-id", "plan", null), plan],
    });
    await expect(load()).resolves.toEqual({
      promptArtifacts: { plan: "latest plan" },
      predecessors: [
        { status: "legacy_unverified", stageId: null, stageSlug: "legacy" },
        { status: "legacy_unverified", stageId: "orphan-id", stageSlug: "plan" },
        { status: "legacy_unverified", stageId: "plan-id", stageSlug: "plan" },
      ],
    });
  });

  it("keeps two distinct legacy versions separate after their current labels swap", async () => {
    const { load } = fixture({
      completed: [completion("plan-id", "plan", "build"), completion("build-id", "build", "plan")],
    });
    await expect(load()).resolves.toMatchObject({
      promptArtifacts: { build: "latest plan", plan: "latest build" },
    });
  });

  it("returns an empty snapshot without looking at artifacts when no stage remains complete", async () => {
    const { load, reads } = fixture({ completed: [] });
    await expect(load()).resolves.toEqual({ promptArtifacts: {}, predecessors: [] });
    expect(reads).toEqual([approvalsPath]);
  });

  it("does not fall back when the completion snapshot cannot be loaded", async () => {
    const { load, reads } = fixture({ completed: [], completionError: "snapshot unavailable" });
    await expect(load()).rejects.toMatchObject({ message: "snapshot unavailable" });
    expect(reads).toEqual([approvalsPath]);
  });

  it("does not guess a legacy artifact after an artifact read fails", async () => {
    const { load } = fixture({ completed: [plan], artifactError: "legacy lookup failed" });
    await expect(load()).rejects.toMatchObject({ message: "legacy lookup failed" });
  });

  it("rejects ties on the highest legacy version and tolerates duplicates below it", async () => {
    const tiedLatest = fixture({
      completed: [plan],
      additionalArtifacts: [{ stage_id: "plan-id", version: 2, artifact_json: "duplicate" }],
    });
    await expect(tiedLatest.load()).rejects.toThrow("multiple artifacts at version 2");
    const tiedOlder = fixture({
      completed: [plan],
      additionalArtifacts: [{ stage_id: "plan-id", version: 1, artifact_json: "duplicate" }],
    });
    await expect(tiedOlder.load()).resolves.toMatchObject({
      promptArtifacts: { plan: "latest plan" },
    });
  });
});
