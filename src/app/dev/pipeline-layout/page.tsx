import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell/app-shell";
import { isProductionDeploy } from "@/env/deploy";
import { PipelineLoadingSkeleton } from "@/features/pipeline/loading-skeleton";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import type { PipelineDashboardData } from "@/features/pipeline/types";

const now = "2026-09-06T14:00:00.000Z";
const workspace = { id: "proof-workspace", name: "Wallie", slug: "proof" };
const titles = [
  "Make the pipeline usable on mobile while preserving review feedback, long session titles, and keyboard navigation",
  "Add separation to the profile dropdown",
  "Show the latest run in session details",
  "Improve keyboard navigation",
  "Keep review feedback visible",
  "Retry failed sessions",
];
const data: PipelineDashboardData = {
  workspace,
  hasAnySession: true,
  onboarding: null,
  lanes: ["Plan", "Build"].map((name, position) => ({
    name,
    position,
    id: `stage-${position}`,
    slug: `stage-${position}`,
    description: "",
    cursor: null,
    pipeline: { id: "proof-pipeline", name: "Default", isDefault: true },
    totalCount: titles.length,
    cards: titles.map((title, index) => ({
      title,
      number: position * 10 + index + 1,
      id: `session-${position}-${index}`,
      workspaceId: workspace.id,
      createdAt: now,
      updatedAt: now,
      currentStageId: `stage-${position}`,
      pipelineId: "proof-pipeline",
      phaseStatus:
        index % 3 === 0 ? "awaiting_review" : index % 3 === 1 ? "in_progress" : "rejected",
      latestRunId: null,
      latestRunStatus: index === 5 ? "error" : null,
      linearIssueId: null,
      linearIssueUrl: null,
      pullRequests: [],
      rejectionCount: 0,
    })),
  })),
};
/** Non-production fixture for loading/loaded geometry and viewport regression tests. */
export default async function PipelineLayoutPreview({
  searchParams,
}: {
  searchParams: Promise<{ loading?: string; empty?: string }>;
}) {
  if (isProductionDeploy()) notFound();
  const params = await searchParams;
  const loading = params.loading === "1";
  const previewData =
    params.empty === "1"
      ? { ...data, lanes: data.lanes.map((lane) => ({ ...lane, cards: [], totalCount: 0 })) }
      : data;
  return (
    <AppShell
      workspace={workspace}
      onboarding={null}
      pathnameOverride="/w/proof"
      viewerId="proof-viewer"
      viewerEmail="preview@example.com"
      viewerAvatarUrl={null}
      workspaceAvatarUrl={null}
    >
      {loading ? (
        <PipelineLoadingSkeleton stageCount={data.lanes.length} />
      ) : (
        <PipelinePageClient enableRealtime={false} initialData={previewData} initialNow={now} />
      )}
    </AppShell>
  );
}
