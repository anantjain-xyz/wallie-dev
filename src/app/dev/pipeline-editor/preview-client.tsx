"use client";

import { useMemo, useState } from "react";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { PipelineEditor, PipelineUnsavedBadge } from "@/features/settings/pipeline-editor";
import { Section } from "@/features/settings/settings-ui";
import type { SessionPipeline } from "@/features/sessions/types";

const MEMBER_ID = "00000000-0000-4000-8000-000000000021";

const fixturePipeline: SessionPipeline = {
  id: "00000000-0000-4000-8000-000000000001",
  isDefault: true,
  name: "Default",
  operatingRulesMd: "Keep changes reviewable and prefer small diffs.",
  stages: [
    {
      approverMemberIds: [MEMBER_ID],
      description: "Define the work before implementation begins",
      id: "00000000-0000-4000-8000-000000000011",
      name: "Plan",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 0,
      promptTemplateMd: "Write a plan for {{session.title}}.",
      slug: "plan",
    },
    {
      approverMemberIds: [MEMBER_ID],
      description: "Implement the approved plan",
      id: "00000000-0000-4000-8000-000000000012",
      name: "Build",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 1,
      promptTemplateMd: "Build the approved plan for {{session.title}}.",
      slug: "build",
    },
    {
      approverMemberIds: [MEMBER_ID],
      description: "Land the change",
      id: "00000000-0000-4000-8000-000000000013",
      name: "Land",
      pipelineId: "00000000-0000-4000-8000-000000000001",
      position: 2,
      promptTemplateMd: "Open a PR and land the approved work.",
      slug: "land",
    },
  ],
};

const workspaceMembers = [
  {
    email: "owner@example.com",
    fullName: "Avery Owner",
    id: MEMBER_ID,
    role: "owner" as const,
  },
  {
    email: "member@example.com",
    fullName: "Morgan Member",
    id: "00000000-0000-4000-8000-000000000022",
    role: "member" as const,
  },
];

export function PipelineEditorDevPreview() {
  const [pipelineDirty, setPipelineDirty] = useState(false);
  const pipeline = useMemo(() => fixturePipeline, []);

  return (
    <OverlayProvider>
      <main className="mx-auto max-w-[1080px] px-4 py-10 sm:px-8">
        <header className="mb-8 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Dev preview</p>
          <h1 className="type-page-title">Pipeline editor</h1>
          <p className="type-body max-w-2xl text-muted">
            Fixture workspace for accessibility and UX proof captures. Historical sessions stay
            pinned to their pipeline; only future sessions use edits saved here.
          </p>
        </header>

        <Section
          anchorId="pipeline"
          statusBadge={<PipelineUnsavedBadge dirty={pipelineDirty} />}
          tagline="Stages run in order; each stage's prompt is sent to the agent, and an approver reviews the markdown output before the session advances. Only future sessions use pipeline edits — historical sessions and artifacts stay unchanged."
          title="Pipeline"
        >
          <PipelineEditor
            canManage
            onDirtyChange={setPipelineDirty}
            pipeline={pipeline}
            workspaceId="00000000-0000-4000-8000-000000000002"
            workspaceMembers={workspaceMembers}
          />
        </Section>
      </main>
    </OverlayProvider>
  );
}
