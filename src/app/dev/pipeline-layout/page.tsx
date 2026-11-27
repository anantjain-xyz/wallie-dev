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

const proofFactories = [
  { id: "product-engineering", name: "Product engineering", status: "active" },
  { id: "customer-tools", name: "Customer tools", status: "active" },
] as const;

const aggregateData: PipelineDashboardData = {
  ...data,
  aggregateFactories: true,
  overviewFactories: [...proofFactories],
  lanes: [
    "Plan the first production release",
    "Implement the accepted delivery plan",
    "Review the generated release evidence",
    "Record the decision and publish",
  ].map((name, position) => {
    const original = data.lanes[position % data.lanes.length]!;
    const id = `aggregate-stage-${position}`;
    const factory = proofFactories[position < 2 ? 0 : 1];
    const pipeline = { ...original.pipeline, id: `proof-pipeline-${factory.id}` };
    return {
      ...original,
      id,
      name,
      cursor: null,
      factory,
      pipeline,
      position,
      cards: original.cards.map((card, index) => ({
        ...card,
        id: `aggregate-session-${position}-${index}`,
        currentStageId: id,
        number: position * 10 + index + 1,
        pipelineId: pipeline.id,
      })),
    };
  }),
};

const longStageData: PipelineDashboardData = {
  ...data,
  lanes: aggregateData.lanes.map((lane) => ({
    ...lane,
    factory: undefined,
    pipeline: data.lanes[0]!.pipeline,
    cards: lane.cards.map((card) => ({ ...card, pipelineId: data.lanes[0]!.pipeline.id })),
  })),
};

/** Non-production fixture for loading/loaded geometry and viewport regression tests. */
export default async function PipelineLayoutPreview({
  searchParams,
}: {
  searchParams: Promise<{
    loading?: string;
    empty?: string;
    partial?: string;
    aggregate?: string;
    longStages?: string;
  }>;
}) {
  if (isProductionDeploy()) notFound();
  const params = await searchParams;
  const loading = params.loading === "1";
  const previewData =
    params.empty === "1"
      ? { ...data, lanes: data.lanes.map((lane) => ({ ...lane, cards: [], totalCount: 0 })) }
      : params.partial === "1"
        ? {
            ...data,
            lanes: data.lanes.map((lane, index) =>
              index === 0
                ? { ...lane, cursor: "preview-next-page", totalCount: lane.totalCount + 1 }
                : lane,
            ),
          }
        : params.aggregate === "1"
          ? aggregateData
          : params.longStages === "1"
            ? longStageData
            : data;
  return (
    <AppShell
      creationFactory={{ id: "proof-default-factory", name: "Proof Factory" }}
      workspace={workspace}
      onboarding={null}
      pathnameOverride="/w/proof"
      viewerId="proof-viewer"
      viewerEmail="preview@example.com"
      viewerAvatarUrl={null}
      workspaceAvatarUrl={null}
    >
      {loading ? (
        <PipelineLoadingSkeleton showFactorySelector={false} stageCount={data.lanes.length} />
      ) : (
        <PipelinePageClient enableRealtime={false} initialData={previewData} initialNow={now} />
      )}
    </AppShell>
  );
}
