"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { Status } from "@/components/ui/status";
import { DeliveryPolicySection } from "@/features/settings/delivery-policy-section";
import type { SettingsPageData } from "@/features/settings/data";
import { useFactoryDefinitionStore } from "@/features/settings/factory-definition-store";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  SETTINGS_PIPELINE_CHANGED,
} from "@/features/settings/settings-island-events";
import { updatePipelineInSettingsData } from "@/features/settings/settings-data-updates";
import { Section } from "@/features/settings/settings-ui";
import { canRouteSettingsThroughFactoryDraft } from "@/lib/factory-definitions/settings-contracts";

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
  const { conflict, state: factoryState } = useFactoryDefinitionStore(
    data.workspace.id,
    data.factoryDefinition,
  );
  const factoryRouted =
    Boolean(data.factoryDefinition) && canRouteSettingsThroughFactoryDraft(factoryState);
  const activePipelineId = factoryState.activeDefinition?.pipelineId ?? data.pipeline?.id ?? null;

  const statusBadge = pipelineDirty ? (
    <Status label="Unsaved changes" value="needs_attention" />
  ) : factoryRouted && conflict ? (
    <Status label="Conflict" value="blocked" />
  ) : factoryRouted && factoryState.latestDraft ? (
    <Status label="Draft saved" value="in_progress" />
  ) : factoryRouted && factoryState.currentActivation ? (
    <Status
      label={`Published #${factoryState.currentActivation.activationNumber}`}
      value="healthy"
    />
  ) : null;

  return (
    <Section
      anchorId="pipeline"
      statusBadge={statusBadge}
      tagline="Each stage runs, then awaits approval. Archiving affects future sessions; existing sessions keep their stages."
      title="Pipeline"
    >
      <PipelineEditor
        canManage={data.canManage}
        factoryDefinition={data.factoryDefinition}
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
      {activePipelineId ? (
        <DeliveryPolicySection
          canManage={data.canManage}
          factoryDefinition={data.factoryDefinition}
          pipelineId={activePipelineId}
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
