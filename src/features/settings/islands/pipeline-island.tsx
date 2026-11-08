"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { Status } from "@/components/ui/status";
import { DeliveryPolicySection } from "@/features/settings/delivery-policy-section";
import type { SettingsPageData } from "@/features/settings/data";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  SETTINGS_PIPELINE_CHANGED,
} from "@/features/settings/settings-island-events";
import { updatePipelineInSettingsData } from "@/features/settings/settings-data-updates";
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
  const [pipelineDirty, setPipelineDirty] = useState(false);

  return (
    <Section
      anchorId="pipeline"
      statusBadge={
        pipelineDirty ? <Status label="Unsaved changes" value="needs_attention" /> : null
      }
      tagline="Each stage runs, then awaits approval. Archiving affects future sessions; existing sessions keep their stages."
      title="Pipeline"
    >
      <PipelineEditor
        canManage={data.canManage}
        onDirtyChange={setPipelineDirty}
        onPipelineSaved={(pipeline) => {
          dispatchSettingsEvent(SETTINGS_PIPELINE_CHANGED, pipeline);
          dispatchSettingsDataChanged(data.workspace.id, (current: SettingsPageData) =>
            updatePipelineInSettingsData(current, pipeline),
          );
        }}
        pipeline={data.pipeline}
        workspaceId={data.workspace.id}
        workspaceMembers={data.workspaceMembers}
      />
      {data.pipeline ? (
        <DeliveryPolicySection
          canManage={data.canManage}
          pipelineId={data.pipeline.id}
          workspaceId={data.workspace.id}
        />
      ) : null}
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
