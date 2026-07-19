"use client";

import { useEffect, useState } from "react";

import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import type {
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardLane,
} from "@/features/pipeline/types";
import type { SessionPhaseStatus } from "@/features/sessions/types";
import { cn } from "@/lib/utils";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000099";
const PIPELINE_ID = "10000000-0000-4000-8000-000000000099";
const FIXED_NOW = "2026-07-18T18:00:00.000Z";

const STAGE_PRESETS: Record<3 | 5 | 7, { description: string; name: string; slug: string }[]> = {
  3: [
    {
      description: "Sessions enter Plan after intake from Linear or the create flow.",
      name: "Plan",
      slug: "plan",
    },
    { description: "Sessions enter Build after Plan approval.", name: "Build", slug: "build" },
    { description: "Sessions enter Land after Build approval.", name: "Land", slug: "land" },
  ],
  5: [
    {
      description: "Sessions enter Discovery when a session is created.",
      name: "Discovery",
      slug: "discovery",
    },
    { description: "Sessions enter Spec after Discovery approval.", name: "Spec", slug: "spec" },
    { description: "Sessions enter Build after Spec approval.", name: "Build", slug: "build" },
    { description: "Sessions enter Review after Build approval.", name: "Review", slug: "review" },
    { description: "Sessions enter Land after Review approval.", name: "Land", slug: "land" },
  ],
  7: [
    { description: "Sessions enter Intake when work is filed.", name: "Intake", slug: "intake" },
    { description: "Sessions enter Plan after Intake approval.", name: "Plan", slug: "plan" },
    { description: "Sessions enter Design after Plan approval.", name: "Design", slug: "design" },
    { description: "Sessions enter Build after Design approval.", name: "Build", slug: "build" },
    { description: "Sessions enter Verify after Build approval.", name: "Verify", slug: "verify" },
    { description: "Sessions enter Review after Verify approval.", name: "Review", slug: "review" },
    { description: "Sessions enter Land after Review approval.", name: "Land", slug: "land" },
  ],
};

const STATUS_CYCLE: SessionPhaseStatus[] = [
  "awaiting_review",
  "agent_generating",
  "rejected",
  "approved",
];

function stageId(index: number) {
  return `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function fixtureCard(
  number: number,
  stageIndex: number,
  phaseStatus: SessionPhaseStatus,
): PipelineDashboardCard {
  const updatedAt = new Date(Date.parse(FIXED_NOW) - number * 60_000).toISOString();
  return {
    createdAt: updatedAt,
    currentStageId: stageId(stageIndex),
    id: `40000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    linearIssueId: number % 2 === 0 ? `OP-${300 + number}` : null,
    linearIssueUrl: number % 2 === 0 ? `https://linear.app/issue/OP-${300 + number}` : null,
    number,
    phaseStatus,
    pipelineId: PIPELINE_ID,
    pullRequests:
      phaseStatus === "approved"
        ? [
            {
              id: `pr-${number}`,
              pullRequestNumber: 400 + number,
              pullRequestUrl: `https://github.com/wallie-dev/wallie/pull/${400 + number}`,
            },
          ]
        : [],
    rejectionCount: phaseStatus === "rejected" ? 1 : 0,
    title:
      phaseStatus === "awaiting_review"
        ? `Review-ready session ${number}`
        : `Pipeline session ${number}`,
    updatedAt,
    workspaceId: WORKSPACE_ID,
  };
}

export function buildPipelineFixtureData(stageCount: 3 | 5 | 7): PipelineDashboardData {
  const stages = STAGE_PRESETS[stageCount];
  const lanes: PipelineDashboardLane[] = stages.map((stage, index) => {
    const cards =
      index === stages.length - 1
        ? []
        : [
            fixtureCard(index * 3 + 1, index, STATUS_CYCLE[index % STATUS_CYCLE.length]!),
            fixtureCard(index * 3 + 2, index, STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length]!),
          ];
    return {
      cards,
      cursor: null,
      description: stage.description,
      id: stageId(index),
      name: stage.name,
      pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
      position: index + 1,
      slug: stage.slug,
      totalCount: cards.length,
    };
  });

  return {
    lanes,
    onboarding: null,
    workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
  };
}

export function PipelineBoardFixture({
  initialTheme = "light",
  stageCount = 3,
}: {
  initialTheme?: "dark" | "light";
  stageCount?: 3 | 5 | 7;
}) {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const data = buildPipelineFixtureData(stageCount);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <main
      className={cn("min-h-screen bg-canvas text-foreground")}
      data-pipeline-board-fixture=""
      data-stage-count={stageCount}
      id="main-content"
    >
      <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-2">
        <div aria-label="Fixture theme" className="flex gap-1" role="group">
          {(["light", "dark"] as const).map((value) => (
            <button
              aria-pressed={theme === value}
              className={theme === value ? "ui-button-primary" : "ui-button"}
              key={value}
              onClick={() => setTheme(value)}
              type="button"
            >
              {value === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </div>
      <PipelinePageClient initialData={data} initialNow={FIXED_NOW} />
    </main>
  );
}
