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

const recordedAt = "2026-11-20T12:00:00.000Z";
const priorDraft = "# Specification\n\nUse audited invoices.";
const specificationInputs = [
  ...originalInputs,
  input("specification/clarification-available", "false"),
  input("specification/prior-draft", priorDraft),
  input(
    "specification/clarification-history",
    "Round 1\nQuestion: Which invoices?\nAnswer: Paid invoices.\n\n" +
      "Round 2\nQuestion: What period?\nAnswer: Last month.",
  ),
];

function specificationFixture(secondAnswer: "retained" | "moved" | "missing") {
  const earlier = "2026-11-20T11:00:00.000Z";
  const later = "2026-11-20T13:00:00.000Z";
  const drafts = [
    { version: 4, created_at: later, artifact_json: "This draft was made after the capture." },
    {
      version: 3,
      created_at: earlier,
      artifact_json:
        '<!-- wallie-clarification: {"question":"Include drafts?"} -->\r\n' + priorDraft,
    },
  ];
  const answers = [
    {
      ordinal: 1,
      question: "Which invoices?",
      answer_text: "Paid invoices.",
      answered_at: earlier,
      artifact_version: 1,
    },
    ...(secondAnswer === "missing"
      ? []
      : [
          {
            ordinal: 2,
            question: "What period?",
            answer_text: "Last month.",
            answered_at: secondAnswer === "moved" ? later : earlier,
            artifact_version: 2,
          },
        ]),
    {
      ordinal: 3,
      question: "Include drafts?",
      answer_text: "No.",
      answered_at: earlier,
      artifact_version: 3,
    },
  ];
  const admin = createClient<Database>("https://capture.example.test", "synthetic-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      async fetch(request) {
        const url = new URL(String(request));
        const query = url.searchParams;
        expect(query.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(query.get("session_id")).toBe(`eq.${sessionId}`);
        expect(query.get("stage_id")).toBe(`eq.${stageId}`);
        if (url.pathname.endsWith("/session_artifacts")) {
          expect(query.get("created_at")).toBe(`lt.${recordedAt}`);
          expect(query.get("order")).toBe("version.desc");
          expect(query.get("limit")).toBe("1");
          const boundary = query.get("created_at")?.slice(3) ?? "";
          return Response.json(drafts.find(({ created_at: createdAt }) => createdAt < boundary));
        }
        expect(url.pathname.endsWith("/session_specification_clarifications")).toBe(true);
        expect(query.get("status")).toBe("eq.answered");
        expect(query.get("artifact_version")).toBe("lt.3");
        expect(query.get("answered_at")).toBe(`lt.${recordedAt}`);
        expect(query.get("order")).toBe("ordinal.asc");
        const boundary = query.get("answered_at")?.slice(3) ?? "";
        const version = Number(query.get("artifact_version")?.slice(3));
        return Response.json(
          answers.filter(
            ({ answered_at: answeredAt, artifact_version: artifactVersion }) =>
              answeredAt < boundary && artifactVersion < version,
          ),
        );
      },
    },
  });
  return { admin, workspaceId, sessionId, stageId, recordedAt };
}

it("verifies the exact draft and ordered clarification history at the attempt boundary", async () => {
  await expect(
    verifyRequiredRunInputs(
      specificationFixture("retained"),
      specificationInputs,
      original,
      async () => true,
    ),
  ).resolves.toEqual([]);
});

it.each(["moved", "missing"] as const)("rejects %s clarification answers", async (secondAnswer) => {
  await expect(
    verifyRequiredRunInputs(
      specificationFixture(secondAnswer),
      specificationInputs,
      original,
      async () => true,
    ),
  ).resolves.toEqual(["A recorded specification input is unavailable."]);
});
