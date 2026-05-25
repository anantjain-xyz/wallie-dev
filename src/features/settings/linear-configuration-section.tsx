"use client";

import type { Dispatch, SetStateAction } from "react";

import type { PipelineStage } from "@/features/sessions/types";
import { LinearKeyControls } from "@/features/settings/linear-key-controls";
import { LinearRoutingEditor } from "@/features/settings/linear-routing-editor";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type { SettingsPageData } from "@/features/settings/data";
import { Section, StatusBadge } from "@/features/settings/settings-ui";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

type LinearConfigurationSectionProps = {
  canManage: boolean;
  isLoadingSecrets: boolean;
  linearSecret: WorkspaceSecretPreview | null;
  onRoutingSaved?: (routing: SettingsPageData["linearRouting"]) => void;
  routing: SettingsPageData["linearRouting"];
  setSecrets: Dispatch<SetStateAction<WorkspaceSecretPreview[]>>;
  stages: PipelineStage[];
  workspaceId: string;
};

export function LinearConfigurationSection({
  canManage,
  isLoadingSecrets,
  linearSecret,
  onRoutingSaved,
  routing,
  setSecrets,
  stages,
  workspaceId,
}: LinearConfigurationSectionProps) {
  const statusBadge = linearSecret ? (
    <StatusBadge tone="success">Connected</StatusBadge>
  ) : (
    <StatusBadge tone="neutral">Not connected</StatusBadge>
  );

  return (
    <Section
      anchorId="linear"
      statusBadge={canManage ? statusBadge : null}
      tagline="Add Linear credentials and route Linear workflow states to Wallie pipeline stages."
      title="Configure Linear"
    >
      <div className="space-y-8">
        <div className="space-y-4">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Linear API key</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Used for reading issues referenced in sessions and syncing status updates.
            </p>
          </div>
          <LinearKeyControls
            canManage={canManage}
            isLoadingSecrets={isLoadingSecrets}
            linearSecret={linearSecret}
            onSecretDeleted={(deletedKey) =>
              setSecrets((current) => current.filter((secret) => secret.key !== deletedKey))
            }
            onSecretSaved={(secret) =>
              setSecrets((current) => upsertSecretPreview(current, secret))
            }
            workspaceId={workspaceId}
          />
        </div>

        <div className="space-y-4 border-t border-border pt-6">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Linear routing</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Map Linear workflow states to pipeline stages so Wallie syncs status correctly.
            </p>
          </div>
          <LinearRoutingEditor
            canManage={canManage}
            onSaved={onRoutingSaved}
            routing={routing}
            stages={stages}
            workspaceId={workspaceId}
          />
        </div>
      </div>
    </Section>
  );
}
