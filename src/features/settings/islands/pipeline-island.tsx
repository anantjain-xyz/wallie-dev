"use client";

import dynamic from "next/dynamic";

import type { SettingsPageData } from "@/features/settings/data";
import { Section } from "@/features/settings/settings-ui";

const loadPipelineEditor = () =>
  import("@/features/settings/pipeline-editor").then((module) => module.PipelineEditor);

const PipelineEditor = dynamic(loadPipelineEditor, {
  loading: () => <PipelineEditorFallback />,
  ssr: false,
});

export function preloadPipelineEditor() {
  void loadPipelineEditor();
}

export function PipelineIsland({ data }: { data: SettingsPageData }) {
  return (
    <Section
      anchorId="pipeline"
      tagline="Stages run in order; each stage prompt is sent to the agent, and an approver reviews the output before the session advances."
      title="Pipeline"
    >
      <PipelineEditor
        canManage={data.canManage}
        pipeline={data.pipeline}
        workspaceId={data.workspace.id}
        workspaceMembers={data.workspaceMembers}
      />
    </Section>
  );
}

export function PipelineEditorFallback() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading pipeline editor"
      className="min-h-72 rounded-[6px] border border-border bg-sheet p-5"
      role="status"
    >
      <div className="h-5 w-48 animate-pulse rounded bg-control-hover" />
      <div className="mt-6 h-40 animate-pulse rounded bg-control-hover" />
    </div>
  );
}
