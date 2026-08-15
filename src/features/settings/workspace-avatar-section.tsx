"use client";

import Image from "next/image";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { Spinner } from "@/components/shared/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { WorkspaceAvatarUploadResponse } from "@/lib/storage/contracts";
import { cn } from "@/lib/utils";

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

const avatarFrameClassName =
  "relative h-16 w-16 shrink-0 overflow-hidden rounded-[6px] border border-border";

export function WorkspaceAvatarSection({
  canManage,
  onWorkspaceNameChange,
  setFlashMessage,
  workspace,
}: WorkspaceAvatarSectionProps) {
  const [workspaceAvatarUrl, setWorkspaceAvatarUrl] = useState(workspace.avatarUrl);
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function openAvatarPicker() {
    if (uploadAvatar.isBusy) return;
    fileInputRef.current?.click();
  }

  const avatarFace = (
    <WorkspaceAvatarFace
      alt={canManage ? "" : `${workspaceName} avatar`}
      name={workspaceName}
      url={workspaceAvatarUrl}
    />
  );

  return (
    <Section
      anchorId="workspace"
      tagline="Workspace identity is shown across navigation, notifications, and PR descriptions."
      title="Workspace"
    >
      <div className="flex flex-wrap items-center gap-4">
        {canManage ? (
          <div className="relative shrink-0">
            <button
              type="button"
              aria-busy={uploadAvatar.isBusy || undefined}
              aria-label="Change workspace avatar"
              className={cn(
                avatarFrameClassName,
                "group cursor-pointer bg-transparent p-0 disabled:cursor-wait",
              )}
              disabled={uploadAvatar.isBusy}
              onClick={openAvatarPicker}
            >
              {avatarFace}
              <span
                aria-hidden={uploadAvatar.isBusy ? undefined : true}
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-foreground/60 px-1 text-center font-semibold text-background type-annotation",
                  uploadAvatar.isBusy
                    ? "opacity-100"
                    : "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
                )}
              >
                {uploadAvatar.isBusy ? (
                  <span className="flex flex-col items-center gap-1">
                    <Spinner label="Uploading…" />
                    <span aria-hidden="true">Uploading…</span>
                  </span>
                ) : (
                  "Change avatar"
                )}
              </span>
            </button>
            <input
              ref={fileInputRef}
              accept=".jpg,.jpeg,.png,.webp"
              aria-hidden="true"
              className="sr-only"
              disabled={uploadAvatar.isBusy}
              onChange={handleAvatarInputChange}
              tabIndex={-1}
              type="file"
            />
          </div>
        ) : (
          <div className={avatarFrameClassName}>{avatarFace}</div>
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

        {canManage ? null : (
          <p className="text-xs leading-5 text-muted">
            Workspace admins can change the name and avatar.
          </p>
        )}
      </div>
    </Section>
  );
}

function WorkspaceAvatarFace({
  alt,
  name,
  url,
}: {
  alt: string;
  name: string;
  url: string | null;
}) {
  if (url) {
    return (
      <Image alt={alt} className="h-full w-full object-cover" height={64} src={url} width={64} />
    );
  }

  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <span className="flex h-full w-full items-center justify-center bg-control-hover text-xl font-semibold text-foreground">
      {initial}
    </span>
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
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const restoreEditFocusRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
      return;
    }

    if (!restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    editButtonRef.current?.focus();
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
      restoreEditFocusRef.current = true;
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

  function returnToReadView() {
    restoreEditFocusRef.current = true;
    setIsEditing(false);
  }

  function cancelEditing() {
    setDraftName(name);
    setError(null);
    returnToReadView();
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
      returnToReadView();
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
      <button
        ref={editButtonRef}
        type="button"
        className="shrink-0 rounded-[4px] text-[13px] font-medium text-muted transition-colors duration-150 hover:text-foreground"
        aria-label="Edit workspace name"
        onClick={startEditing}
      >
        Edit
      </button>
    </div>
  );
}
