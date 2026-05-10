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
    <Section title="Workspace">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-4">
          {workspaceAvatarUrl ? (
            <Image
              alt={`${workspace.name} avatar`}
              className="h-20 w-20 rounded-[1.75rem] border border-border/70 object-cover"
              height={80}
              src={workspaceAvatarUrl}
              width={80}
            />
          ) : (
            <AvatarFallback name={workspace.name} />
          )}

          <div className="space-y-1">
            <p className="text-xl font-semibold tracking-tight text-foreground">{workspace.name}</p>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              /w/{workspace.slug}
            </p>
          </div>
        </div>

        {canManage ? (
          <label className="ui-subpanel flex w-full cursor-pointer items-center justify-between px-4 py-4 text-sm font-semibold text-foreground transition-[border-color,box-shadow] duration-150 hover:border-accent/45">
            <span>
              {uploadAvatar.isBusy ? "Uploading Workspace Avatar…" : "Upload Workspace Avatar"}
            </span>
            <input
              accept=".jpg,.jpeg,.png,.webp"
              className="sr-only"
              disabled={uploadAvatar.isBusy}
              onChange={handleAvatarInputChange}
              type="file"
            />
          </label>
        ) : (
          <p className="text-sm leading-6 text-muted">
            Workspace admins can change the avatar and manage integrations from this page.
          </p>
        )}
      </div>
    </Section>
  );
}
