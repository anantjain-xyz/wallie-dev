"use client";

import Image from "next/image";
import type { ChangeEvent } from "react";
import { useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { AvatarFallback, Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { WorkspaceAvatarUploadResponse } from "@/lib/storage/contracts";

type WorkspaceAvatarSectionProps = {
  canManage: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  workspace: SettingsPageData["workspace"];
};

export function WorkspaceAvatarSection({
  canManage,
  setFlashMessage,
  workspace,
}: WorkspaceAvatarSectionProps) {
  const [workspaceAvatarUrl, setWorkspaceAvatarUrl] = useState(workspace.avatarUrl);

  const uploadAvatar = useApiAction<WorkspaceAvatarUploadResponse, [File]>({
    call: (file) => {
      const formData = new FormData();

      formData.append("file", file);

      return fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/avatar`, {
        body: formData,
        method: "POST",
      });
    },
    errorText: "Workspace avatar upload failed.",
    onSuccess: (payload) => {
      setWorkspaceAvatarUrl(payload.avatarUrl);
    },
    setFlashMessage,
    successText: "Workspace avatar updated.",
  });

  function handleAvatarInputChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    void uploadAvatar.run(file).finally(() => {
      input.value = "";
    });
  }

  return (
    <Section
      anchorId="workspace"
      tagline="Workspace identity is shown across navigation, notifications, and PR descriptions."
      title="Workspace"
    >
      <div className="flex flex-wrap items-center gap-4">
        {workspaceAvatarUrl ? (
          <Image
            alt={`${workspace.name} avatar`}
            className="h-16 w-16 rounded-[10px] border border-border object-cover"
            height={64}
            src={workspaceAvatarUrl}
            width={64}
          />
        ) : (
          <AvatarFallback name={workspace.name} />
        )}

        <div className="flex-1 space-y-1">
          <p className="text-[16px] font-semibold tracking-tight text-foreground">
            {workspace.name}
          </p>
          <p className="font-mono text-[12px] text-muted">/w/{workspace.slug}</p>
        </div>

        {canManage ? (
          <label className="ui-button cursor-pointer">
            <span>{uploadAvatar.isBusy ? "Uploading…" : "Upload avatar"}</span>
            <input
              accept=".jpg,.jpeg,.png,.webp"
              className="sr-only"
              disabled={uploadAvatar.isBusy}
              onChange={handleAvatarInputChange}
              type="file"
            />
          </label>
        ) : (
          <p className="text-[12px] leading-5 text-muted">
            Workspace admins can change the avatar.
          </p>
        )}
      </div>
    </Section>
  );
}
