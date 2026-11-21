import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import type { Database } from "@/lib/supabase/database.types";

import { verifyRequiredRunInputs } from "./capture-required";

const id = (suffix: number) => "61200000-0000-4000-8000-" + String(suffix).padStart(12, "0");
const workspaceId = id(1);
const sessionId = id(2);
const stageId = id(3);
const approvalId = id(4);
const artifactId = id(5);
const feedbackId = id(6);
const repositoryId = id(7);
const commitSha = "a".repeat(40);
const original = { title: "Résumé planning", prompt: "Use the reviewed requirements." };
const input = (key: string, body: string) => ({ key, ...fingerprintRunContextInput(body) });
const originalInputs = [
  input("session/title", original.title),
  input("session/prompt", original.prompt),
];
const predecessorKey = `predecessor/${stageId}/old-stage-name/${approvalId}/${artifactId}/3`;

function fixture({
  approval,
  artifact,
  feedback,
}: { approval?: unknown; artifact?: unknown; feedback?: string } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
    const url = new URL(
      typeof request === "string" || request instanceof URL ? request : request.url,
    );
    const path = url.pathname.split("/").at(-1);
    expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
    expect(url.searchParams.get("session_id")).toBe(`eq.${sessionId}`);
    switch (path) {
      case "session_stage_approval_receipts":
        expect(url.searchParams.get("id")).toBe(`eq.${approvalId}`);
        expect(url.searchParams.get("stage_id")).toBe(`eq.${stageId}`);
        expect(url.searchParams.get("artifact_id")).toBe(`eq.${artifactId}`);
        expect(url.searchParams.get("artifact_version")).toBe("eq.3");
        return Response.json(approval ?? null);
      case "session_artifacts":
        expect(url.searchParams.get("id")).toBe(`eq.${artifactId}`);
        expect(url.searchParams.get("version")).toBe("eq.3");
        expect(url.searchParams.get("select")).toContain("canonical:artifact_json::text");
        expect(url.searchParams.has("stage_slug")).toBe(false);
        return Response.json(artifact ?? null);
      case "artifact_feedback_batches":
        expect(url.searchParams.get("id")).toBe(`eq.${feedbackId}`);
        return Response.json({ rendered_feedback_text: feedback });
      case "session_artifact_feedback":
        expect(url.searchParams.get("id")).toBe(`eq.${feedbackId}`);
        expect(url.searchParams.get("target_version")).toBe("eq.4");
        return Response.json({ feedback_text: feedback });
      default:
        throw new Error("Unexpected input verification lookup.");
    }
  });
  const admin = createClient<Database>("https://capture.example.test", "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { admin, workspaceId, sessionId };
}

it("verifies exact original inputs, an approved predecessor whose stage was deleted, and frozen feedback", async () => {
  const artifact = "Reviewed draft\n";
  const predecessor = input(predecessorKey, artifact);
  const feedback = "Clarify naïve case handling.";
  const repository = input(`repository/${repositoryId}/${commitSha}`, "example/context\n123");
  const scope = fixture({
    approval: { artifact_digest: predecessor.sha256 },
    artifact: { stage_id: null, artifact_json: artifact },
    feedback,
  });
  const verifyRepository = vi.fn(async () => true);
  await expect(
    verifyRequiredRunInputs(
      scope,
      [
        ...originalInputs,
        predecessor,
        input(`feedback/batch/${feedbackId}`, feedback),
        repository,
        input("specification/clarification-available", "false"),
      ],
      original,
      verifyRepository,
    ),
  ).resolves.toEqual([]);
  expect(verifyRepository).toHaveBeenCalledExactlyOnceWith({
    repositoryId,
    commitSha,
    sha256: repository.sha256,
    utf8Bytes: repository.utf8Bytes,
  });
});

it("checks the PostgreSQL JSONB representation and exact legacy feedback bytes", async () => {
  const predecessor = input(predecessorKey, '{"summary": "Reviewed draft"}');
  const feedback = "Original feedback.";
  const scope = fixture({
    approval: { artifact_digest: predecessor.sha256 },
    artifact: {
      stage_id: stageId,
      artifact_json: { summary: "Reviewed draft" },
      canonical: '{"summary": "Reviewed draft"}',
    },
    feedback,
  });
  await expect(
    verifyRequiredRunInputs(
      scope,
      [
        ...originalInputs,
        predecessor,
        input(`feedback/artifact/${feedbackId}/4`, "Different feedback."),
        input("specification/clarification-available", "true"),
      ],
      original,
      async () => true,
    ),
  ).resolves.toEqual(["A recorded feedback input is unavailable or changed."]);
});

it("requires canonical bytes for legacy JSON even when the approval hash matches", async () => {
  const predecessor = input(predecessorKey, '{"summary": "Reviewed draft"}');
  const scope = fixture({
    approval: { artifact_digest: predecessor.sha256 },
    artifact: { stage_id: stageId, artifact_json: { summary: "Reviewed draft" } },
  });
  await expect(
    verifyRequiredRunInputs(scope, [...originalInputs, predecessor], original, async () => true),
  ).resolves.toEqual(["A recorded predecessor approval or artifact is unavailable or changed."]);
});

it("reports changed retained Markdown, unsupported inputs and missing original receipts without exposing keys", async () => {
  const predecessor = input(predecessorKey, "Previously approved body.");
  const scope = fixture({
    approval: { artifact_digest: predecessor.sha256 },
    artifact: { stage_id: stageId, artifact_json: "A different body." },
  });
  await expect(
    verifyRequiredRunInputs(
      scope,
      [
        input("session/title", "Previously recorded title"),
        predecessor,
        input("specification/prior-draft", "Previously retained draft"),
        input("specification/clarification-available", "unknown"),
        input("unexpected/private-reference", "Secret history"),
      ],
      original,
      async () => true,
    ),
  ).resolves.toEqual([
    "The original session title is unavailable or changed.",
    "The original session prompt is unavailable or changed.",
    "A recorded predecessor approval or artifact is unavailable or changed.",
    "A recorded specification input is unavailable.",
    "A required run input could not be verified from retained history.",
  ]);
});
