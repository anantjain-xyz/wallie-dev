import "server-only";

import { formatWallieRunMode } from "@/lib/wallie/core";
import type { WallieRunMode } from "@/lib/wallie/types";

type StubIssueContext = {
  createdAt: string;
  descriptionMd: string;
  number: number;
  title: string;
};

type StubRepositoryContext = {
  fullName: string;
  id: string;
} | null;

export type StubProjectArtifacts = {
  designMd: string;
  planMd: string;
};

export type StubCodeArtifacts = {
  branchName: string;
  githubRepositoryId: string;
};

export type StubWallieExecutionContext = {
  appendMessage: (kind: "error" | "output" | "status", message: string) => Promise<void>;
  issue: StubIssueContext;
  persistCodeArtifacts: (artifacts: StubCodeArtifacts) => Promise<void>;
  persistProjectArtifacts: (artifacts: StubProjectArtifacts) => Promise<void>;
  repository: StubRepositoryContext;
  run: {
    createdAt: string;
    runType: WallieRunMode;
  };
};

function normalizeIssueDescription(descriptionMd: string) {
  const trimmed = descriptionMd.trim();

  return trimmed.length > 0 ? trimmed : "No description was provided on the issue.";
}

export function buildStubProjectArtifacts(input: {
  issue: StubIssueContext;
  runCreatedAt: string;
}) {
  const description = normalizeIssueDescription(input.issue.descriptionMd);
  const generatedDate = new Date(input.runCreatedAt).toISOString();

  return {
    designMd: [
      "# Wallie Stub Design",
      "",
      `Generated for issue #${input.issue.number} on ${generatedDate}.`,
      "",
      "## Goal",
      input.issue.title,
      "",
      "## Context",
      description,
      "",
      "## Proposed Direction",
      "- Keep the implementation inside the cloud rebuild architecture.",
      "- Prefer typed route contracts and resumable queue processing.",
      "- Treat the final executor as a later swap-in behind the current control-plane contract.",
    ].join("\n"),
    planMd: [
      "# Wallie Stub Plan",
      "",
      `Generated for issue #${input.issue.number}.`,
      "",
      "1. Confirm the user-facing outcome and acceptance criteria for the issue.",
      "2. Identify the smallest route, schema, and integration changes needed.",
      "3. Implement the control-plane-safe version first and verify it with tests.",
      "4. Record assumptions, risks, and follow-up executor work before handoff.",
    ].join("\n"),
  } satisfies StubProjectArtifacts;
}

export function buildStubBranchName(issueNumber: number) {
  return `wallie/issue-${issueNumber}`;
}

export async function executeStubWallieRun(
  context: StubWallieExecutionContext,
) {
  await context.appendMessage(
    "status",
    `${formatWallieRunMode(context.run.runType)} selected for issue #${context.issue.number}.`,
  );

  if (context.run.runType === "project") {
    const artifacts = buildStubProjectArtifacts({
      issue: context.issue,
      runCreatedAt: context.run.createdAt,
    });

    await context.persistProjectArtifacts(artifacts);
    await context.appendMessage(
      "output",
      "Stub executor wrote deterministic `design_md` and `plan_md` content to the issue.",
    );
    return;
  }

  if (!context.repository) {
    throw new Error("Code-mode run requires a linked repository.");
  }

  const branchName = buildStubBranchName(context.issue.number);

  await context.persistCodeArtifacts({
    branchName,
    githubRepositoryId: context.repository.id,
  });
  await context.appendMessage(
    "output",
    `Stub executor recorded branch \`${branchName}\` for ${context.repository.fullName}.`,
  );
}
