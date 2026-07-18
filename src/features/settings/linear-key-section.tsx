"use client";

import type { Dispatch, SetStateAction } from "react";

import { Status } from "@/components/ui/status";
import { LinearKeyControls } from "@/features/settings/linear-key-controls";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
import { interactiveLinkClass, Section } from "@/features/settings/settings-ui";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";

type LinearKeySectionProps = {
  canManage: boolean;
  isLoadingSecrets: boolean;
  linearSecret: WorkspaceSecretPreview | null;
  setSecrets: Dispatch<SetStateAction<WorkspaceSecretPreview[]>>;
  workspaceId: string;
};

export function LinearKeySection({
  canManage,
  isLoadingSecrets,
  linearSecret,
  setSecrets,
  workspaceId,
}: LinearKeySectionProps) {
  const statusBadge = canManage ? (
    linearSecret ? (
      <Status label="Connected" value="healthy" />
    ) : (
      <Status label="Not connected" value="not_started" />
    )
  ) : null;

  return (
    <Section
      anchorId="linear"
      statusBadge={statusBadge}
      tagline={
        <>
          Paste a Linear personal API key so Wallie can read issues referenced in sessions. Generate
          one at{" "}
          <a
            className={interactiveLinkClass}
            href="https://linear.app/settings/account/security"
            rel="noreferrer"
            target="_blank"
          >
            linear.app/settings/account/security
          </a>
          .
        </>
      }
      title="Linear"
    >
      <LinearKeyControls
        canManage={canManage}
        isLoadingSecrets={isLoadingSecrets}
        linearSecret={linearSecret}
        onSecretDeleted={(deletedKey) =>
          setSecrets((current) => current.filter((secret) => secret.key !== deletedKey))
        }
        onSecretSaved={(secret) => setSecrets((current) => upsertSecretPreview(current, secret))}
        workspaceId={workspaceId}
      />
    </Section>
  );
}
