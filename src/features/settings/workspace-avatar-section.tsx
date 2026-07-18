"use client";

import Image from "next/image";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { CheckIcon, PencilIcon, XIcon } from "@/components/shared/icons";
import { Spinner } from "@/components/shared/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { AvatarFallback, Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { WorkspaceAvatarUploadResponse } from "@/lib/storage/contracts";

type WorkspaceNameUpdateResponse = {
  id: string;
  name: string;
  updatedAt: string;
};

type WorkspaceAvatarSectionProps = {
  canManage: boolean;
  onWorkspaceNameChange?: (name: string) => void;
  setFlashMessage: (message: FlashMessage) => void;
  workspace: SettingsPageData["workspace"];
};

export function WorkspaceAvatarSection({
  canManage,
  onWorkspaceNameChange,
  setFlashMessage,
  workspace,
}: WorkspaceAvatarSectionProps) {
  const [workspaceAvatarUrl, setWorkspaceAvatarUrl] = useState(workspace.avatarUrl);
  const [workspaceName, setWorkspaceName] = useState(workspace.name);

  // Lift the saved name to the parent settings data too, so sibling sections
  // (e.g. the danger-zone delete confirmation) compare against the current name
  // rather than the stale value rendered at page load.
  function handleNameSaved(nextName: string) {
    setWorkspaceName(nextName);
    onWorkspaceNameChange?.(nextName);
  }

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
            alt={`${workspaceName} avatar`}
            className="h-16 w-16 rounded-[6px] border border-border object-cover"
            height={64}
            src={workspaceAvatarUrl}
            width={64}
          />
        ) : (
          <AvatarFallback name={workspaceName} />
        )}

        <div className="min-w-0 flex-1 space-y-1">
          {canManage ? (
            <EditableWorkspaceName
              name={workspaceName}
              onNameSaved={handleNameSaved}
              setFlashMessage={setFlashMessage}
              workspaceId={workspace.id}
            />
          ) : (
            <p className="text-[16px] font-semibold tracking-tight text-foreground">
              {workspaceName}
            </p>
          )}
          <p className="type-code text-muted">/w/{workspace.slug}</p>
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
          <p className="text-xs leading-5 text-muted">
            Workspace admins can change the name and avatar.
          </p>
        )}
      </div>
    </Section>
  );
}

function EditableWorkspaceName({
  name,
  onNameSaved,
  setFlashMessage,
  workspaceId,
}: {
  name: string;
  onNameSaved: (name: string) => void;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
}) {
  const [draftName, setDraftName] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [isEditing]);

  const saveName = useApiAction<WorkspaceNameUpdateResponse, [string]>({
    call: (nextName) =>
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        body: JSON.stringify({ name: nextName }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    errorText: "Workspace name update failed.",
    onError: (message) => {
      setError(message);
    },
    onSuccess: (payload) => {
      onNameSaved(payload.name);
      setDraftName(payload.name);
      setIsEditing(false);
    },
    setFlashMessage,
    successText: "Workspace name updated.",
  });

  function startEditing() {
    setDraftName(name);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraftName(name);
    setError(null);
    setIsEditing(false);
  }

  function submit() {
    if (saveName.isBusy) return;

    const normalizedName = draftName.trim();

    if (!normalizedName) {
      setError("Workspace name is required.");
      return;
    }

    if (normalizedName === name) {
      setError(null);
      setIsEditing(false);
      return;
    }

    setError(null);
    void saveName.run(normalizedName);
  }

  if (isEditing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <input
            ref={editInputRef}
            aria-label="Workspace name"
            className="ui-input h-9 min-w-0 flex-1 px-3 py-1.5 text-[16px] font-semibold"
            disabled={saveName.isBusy}
            maxLength={80}
            value={draftName}
            onChange={(event) => {
              setDraftName(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              }
            }}
          />
          <Tooltip content="Save workspace name">
            <button
              type="button"
              className="ui-icon-button h-8 w-8 text-accent"
              aria-label="Save workspace name"
              disabled={saveName.isBusy}
              onClick={submit}
            >
              {saveName.isBusy ? (
                <Spinner className="h-4 w-4" label="Saving workspace name" />
              ) : (
                <CheckIcon className="h-4 w-4" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Cancel workspace name edit">
            <button
              type="button"
              className="ui-icon-button h-8 w-8"
              aria-label="Cancel workspace name edit"
              disabled={saveName.isBusy}
              onClick={cancelEditing}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
        {error ? (
          <p className="text-xs leading-4 text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <p className="min-w-0 truncate text-[16px] font-semibold tracking-tight text-foreground">
        {name}
      </p>
      <Tooltip content="Edit workspace name">
        <button
          type="button"
          className="ui-icon-button h-7 w-7 shrink-0"
          aria-label="Edit workspace name"
          onClick={startEditing}
        >
          <PencilIcon className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
