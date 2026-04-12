import type { Enums } from "@/lib/supabase/database.types";

export type PipelinePhaseStatus = Enums<"pipeline_phase_status">;

export const PIPELINE_JOB_TYPE = "pipeline" as const;
export const PIPELINE_MODEL_NAME = "claude-sonnet-4-20250514" as const;
export const PIPELINE_ESCALATION_THRESHOLD = 3;

export interface ProductSpec {
  title: string;
  problem_statement: string;
  user_story: string;
  acceptance_criteria: string[];
  constraints: string[];
  non_goals: string[];
  open_questions: string[];
}

export function specToMarkdown(spec: ProductSpec): string {
  const lines: string[] = [];

  lines.push(`# ${spec.title}`);
  lines.push("");
  lines.push("## Problem Statement");
  lines.push("");
  lines.push(spec.problem_statement);
  lines.push("");
  lines.push("## User Story");
  lines.push("");
  lines.push(spec.user_story);
  lines.push("");
  lines.push("## Acceptance Criteria");
  lines.push("");
  for (const criterion of spec.acceptance_criteria) {
    lines.push(`- ${criterion}`);
  }

  if (spec.constraints.length > 0) {
    lines.push("");
    lines.push("## Constraints");
    lines.push("");
    for (const constraint of spec.constraints) {
      lines.push(`- ${constraint}`);
    }
  }

  if (spec.non_goals.length > 0) {
    lines.push("");
    lines.push("## Non-Goals");
    lines.push("");
    for (const nonGoal of spec.non_goals) {
      lines.push(`- ${nonGoal}`);
    }
  }

  if (spec.open_questions.length > 0) {
    lines.push("");
    lines.push("## Open Questions");
    lines.push("");
    for (const question of spec.open_questions) {
      lines.push(`- ${question}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function markdownToSpec(md: string): ProductSpec {
  const spec: ProductSpec = {
    acceptance_criteria: [],
    constraints: [],
    non_goals: [],
    open_questions: [],
    problem_statement: "",
    title: "",
    user_story: "",
  };

  const lines = md.split("\n");
  let currentSection = "";
  // Track which list-based array we're currently appending to for
  // multiline continuation support.
  let activeList: string[] | null = null;

  const listSectionArrays: Record<string, string[]> = {
    "acceptance criteria": spec.acceptance_criteria,
    constraints: spec.constraints,
    "non-goals": spec.non_goals,
    "open questions": spec.open_questions,
  };

  for (const line of lines) {
    const h1Match = line.match(/^# (.+)$/);
    if (h1Match) {
      spec.title = h1Match[1]!.trim();
      currentSection = "";
      activeList = null;
      continue;
    }

    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      currentSection = h2Match[1]!.trim().toLowerCase();
      activeList = null;
      continue;
    }

    const listMatch = line.match(/^- (.+)$/);
    if (listMatch) {
      const arr = listSectionArrays[currentSection];
      if (arr) {
        arr.push(listMatch[1]!.trim());
        activeList = arr;
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") {
      activeList = null;
      continue;
    }

    // Multiline continuation of a list item
    if (activeList && activeList.length > 0) {
      activeList[activeList.length - 1] += " " + trimmed;
      continue;
    }

    switch (currentSection) {
      case "problem statement":
        spec.problem_statement += (spec.problem_statement ? " " : "") + trimmed;
        break;
      case "user story":
        spec.user_story += (spec.user_story ? " " : "") + trimmed;
        break;
    }
  }

  return spec;
}

export interface PreScreenResult {
  pass: boolean;
  reason: string;
}

export interface SlackMentionContext {
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  linearUrl: string | null;
}

export function buildPipelineDedupeKey(linearIssueId: string): string {
  return `pipeline:${linearIssueId}:active`;
}
