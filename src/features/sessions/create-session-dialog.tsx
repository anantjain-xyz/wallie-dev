"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MultiSelectField } from "@/components/ui/multi-select-field";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { SelectField } from "@/components/ui/select";
import {
  createSessionFromClient,
  deletePendingSessionAttachmentFromClient,
  uploadSessionAttachmentFromClient,
} from "@/features/sessions/client";
import { extractLinearIssueId } from "@/features/sessions/linear-issue-url";
import {
  SessionImageAttachments,
  type SessionImageDraft,
} from "@/features/sessions/session-image-attachments";
import {
  isSessionSubmitShortcut,
  SESSION_SUBMIT_KEY_SHORTCUTS,
} from "@/features/sessions/session-submit-shortcut";
import {
  invalidateSessionRepositoryCache,
  preloadSessionRepositories as preloadSessionRepositoryCache,
  retrySessionRepositories,
  useSessionRepositories,
  type SessionRepositoryCacheKey,
  type SessionRepositorySnapshot,
} from "@/features/sessions/session-repository-cache";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import {
  allowedSessionAttachmentMimeTypes,
  maxSessionAttachmentBytes,
  maxSessionAttachments,
} from "@/lib/storage/contracts";
import { finishInteraction } from "@/lib/telemetry/interaction-rum";

type CreateSessionDialogProps = {
  onClose: () => void;
  open: boolean;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
};

export function getLinearUrlError(value: string) {
  const trimmed = value.trim();
  if (!trimmed || extractLinearIssueId(trimmed)) {
    return null;
  }

  return "Must be a Linear issue URL.";
}

function isSessionOptionsChangedError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "session_options_changed";
}

export function preloadSessionRepositories(input: SessionRepositoryCacheKey) {
  return preloadSessionRepositoryCache(input);
}

export function isCreateSessionSubmitDisabled(input: {
  hasRepositoryResult: boolean;
  isRepositoryStale: boolean;
  isSubmitting: boolean;
  linearUrl: string;
  prompt: string;
  selectedStageCount: number;
  stageCount: number;
  hasBlockingAttachments?: boolean;
}) {
  const hasInvalidLinearUrl = Boolean(getLinearUrlError(input.linearUrl));

  return (
    input.isSubmitting ||
    Boolean(input.hasBlockingAttachments) ||
    hasInvalidLinearUrl ||
    (!input.linearUrl.trim() && !input.prompt.trim()) ||
    !input.hasRepositoryResult ||
    input.isRepositoryStale ||
    input.stageCount === 0 ||
    input.selectedStageCount === 0
  );
}

// When `open` is false the body does not mount, so all of its local state is
// reset automatically on reopen. This avoids a reset effect (which the
// react-hooks/set-state-in-effect lint rule forbids).
export function CreateSessionDialog(props: CreateSessionDialogProps) {
  if (!props.open) {
    return null;
  }
  return <CreateSessionDialogBody {...props} />;
}

function CreateSessionDialogBody({ onClose, userId, workspaceId }: CreateSessionDialogProps) {
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const submitInFlightRef = useRef(false);
  const sessionCommittedRef = useRef(false);
  const imageDraftsRef = useRef<SessionImageDraft[]>([]);

  useEffect(() => {
    finishInteraction("open_create_dialog", "success");
  }, []);

  const [prompt, setPrompt] = useState("");
  const [imageDrafts, setImageDrafts] = useState<SessionImageDraft[]>([]);
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [linearUrl, setLinearUrl] = useState("");
  const [githubRepositoryId, setGithubRepositoryId] = useState("");
  const [excludedStageIds, setExcludedStageIds] = useState<string[]>([]);
  const [linearError, setLinearError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const repositoryCacheKey = { userId, workspaceId };
  const repositorySnapshot = useSessionRepositories(repositoryCacheKey);
  const repositoryOptions = repositorySnapshot.data?.repositoryOptions ?? [];
  const stageOptions = repositorySnapshot.data?.stageOptions ?? [];
  const excludedStageIdSet = new Set(excludedStageIds);
  const selectedStageIds = stageOptions
    .filter((stage) => !excludedStageIdSet.has(stage.id))
    .map((stage) => stage.id);
  const hasBlockingAttachments = imageDrafts.some((image) => image.status !== "ready");
  const hasActiveAttachmentOperation = imageDrafts.some(
    (image) => image.status === "uploading" || image.status === "removing",
  );

  useEffect(() => {
    return () => {
      for (const image of imageDraftsRef.current) {
        URL.revokeObjectURL(image.previewUrl);
        if (!sessionCommittedRef.current && image.attachmentId) {
          void deletePendingSessionAttachmentFromClient({
            attachmentId: image.attachmentId,
            workspaceId,
          }).catch(() => undefined);
        }
      }
    };
  }, [workspaceId]);

  function updateImageDrafts(
    update: SessionImageDraft[] | ((current: SessionImageDraft[]) => SessionImageDraft[]),
  ) {
    const next = typeof update === "function" ? update(imageDraftsRef.current) : update;
    imageDraftsRef.current = next;
    setImageDrafts(next);
  }

  function handleImageFiles(files: File[]) {
    const availableSlots = maxSessionAttachments - imageDraftsRef.current.length;
    if (availableSlots <= 0) {
      setAttachmentMessage("A session may include at most five images.");
      return;
    }

    const selectedFiles = files.slice(0, availableSlots);
    const rejectedFiles = selectedFiles.filter(
      (file) =>
        !allowedSessionAttachmentMimeTypes.includes(
          file.type as (typeof allowedSessionAttachmentMimeTypes)[number],
        ) ||
        file.size < 1 ||
        file.size > maxSessionAttachmentBytes,
    );
    const validFiles = selectedFiles.filter((file) => !rejectedFiles.includes(file));

    if (files.length > availableSlots) {
      setAttachmentMessage("Only the first available images were added; the limit is five.");
    } else if (rejectedFiles.length > 0) {
      setAttachmentMessage("Use PNG, JPEG, or WebP images under 4 MB each.");
    } else {
      setAttachmentMessage(null);
    }

    const drafts = validFiles.map((file) => ({
      clientId: crypto.randomUUID(),
      file,
      fileName: file.name || "Pasted image",
      previewUrl: URL.createObjectURL(file),
      sizeBytes: file.size,
      status: "uploading" as const,
    }));
    if (drafts.length === 0) return;

    updateImageDrafts((current) => [...current, ...drafts]);
    for (const draft of drafts) {
      void uploadImageDraft(draft.clientId, draft.file);
    }
  }

  async function uploadImageDraft(clientId: string, file: File) {
    try {
      const uploaded = await uploadSessionAttachmentFromClient({ file, workspaceId });
      updateImageDrafts((current) =>
        current.map((image) =>
          image.clientId === clientId
            ? {
                ...image,
                attachmentId: uploaded.id,
                error: undefined,
                fileName: uploaded.fileName,
                sizeBytes: uploaded.sizeBytes,
                status: "ready",
              }
            : image,
        ),
      );
    } catch (error) {
      updateImageDrafts((current) =>
        current.map((image) =>
          image.clientId === clientId
            ? {
                ...image,
                error: error instanceof Error ? error.message : "Image upload failed.",
                status: "error",
              }
            : image,
        ),
      );
    }
  }

  async function handleRemoveImage(clientId: string) {
    const image = imageDraftsRef.current.find((candidate) => candidate.clientId === clientId);
    if (!image) return;

    if (!image.attachmentId) {
      URL.revokeObjectURL(image.previewUrl);
      updateImageDrafts((current) =>
        current.filter((candidate) => candidate.clientId !== clientId),
      );
      return;
    }

    updateImageDrafts((current) =>
      current.map((candidate) =>
        candidate.clientId === clientId
          ? { ...candidate, error: undefined, status: "removing" }
          : candidate,
      ),
    );

    try {
      await deletePendingSessionAttachmentFromClient({
        attachmentId: image.attachmentId,
        workspaceId,
      });
      URL.revokeObjectURL(image.previewUrl);
      updateImageDrafts((current) =>
        current.filter((candidate) => candidate.clientId !== clientId),
      );
    } catch (error) {
      updateImageDrafts((current) =>
        current.map((candidate) =>
          candidate.clientId === clientId
            ? {
                ...candidate,
                error: error instanceof Error ? error.message : "Image removal failed.",
                status: "error",
              }
            : candidate,
        ),
      );
    }
  }

  function handleRetryImage(clientId: string) {
    const image = imageDraftsRef.current.find((candidate) => candidate.clientId === clientId);
    if (!image) return;
    if (image.attachmentId) {
      void handleRemoveImage(clientId);
      return;
    }

    updateImageDrafts((current) =>
      current.map((candidate) =>
        candidate.clientId === clientId
          ? { ...candidate, error: undefined, status: "uploading" }
          : candidate,
      ),
    );
    void uploadImageDraft(clientId, image.file);
  }

  function handleLinearBlur() {
    setLinearError(getLinearUrlError(linearUrl));
  }

  function handleLinearChange(value: string) {
    setLinearUrl(value);
    if (linearError) {
      setLinearError(getLinearUrlError(value));
    }
  }

  const derivedTitle = deriveSessionTitleFromPrompt(prompt);
  const hasLinearIssue = Boolean(extractLinearIssueId(linearUrl.trim()));
  const repositorySelectOptions = repositoryOptions.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
  const defaultGithubRepositoryId = repositorySnapshot.data?.defaultGithubRepositoryId ?? null;
  const defaultRepositoryAvailable = repositoryOptions.some(
    (repository) => repository.id === defaultGithubRepositoryId,
  );
  const fallbackRepositoryId = defaultRepositoryAvailable
    ? (defaultGithubRepositoryId ?? "")
    : (repositoryOptions[0]?.id ?? "");
  const selectedGithubRepositoryId = repositoryOptions.some(
    (repository) => repository.id === githubRepositoryId,
  )
    ? githubRepositoryId
    : fallbackRepositoryId;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitInFlightRef.current) {
      return;
    }

    if (!repositorySnapshot.data) {
      setErrorMessage("Wait for repositories to finish loading before starting a session.");
      return;
    }

    if (repositorySnapshot.isStale) {
      setErrorMessage("Refresh session options before starting a session.");
      return;
    }

    if (!prompt.trim() && !linearUrl.trim()) {
      setErrorMessage("Enter a Linear issue URL or a prompt.");
      return;
    }

    if (selectedStageIds.length === 0) {
      setErrorMessage("Select at least one stage.");
      return;
    }

    if (hasBlockingAttachments) {
      setErrorMessage("Wait for every image upload to finish or remove failed images.");
      return;
    }

    const nextLinearError = getLinearUrlError(linearUrl);
    if (nextLinearError) {
      setLinearError(nextLinearError);
      setErrorMessage("Fix the Linear URL before submitting.");
      return;
    }

    setErrorMessage(null);
    submitInFlightRef.current = true;
    setIsSubmitting(true);

    try {
      const result = await createSessionFromClient({
        attachmentIds: imageDrafts.map((image) => image.attachmentId!),
        githubRepositoryId: selectedGithubRepositoryId || null,
        linearIssueUrl: linearUrl.trim() || null,
        promptMd: prompt.trim(),
        selectedStageIds,
        title: title.trim() || null,
        workspaceId,
      });
      // The dialog now lives in the workspace shell (stays mounted across
      // route changes), so we must explicitly close it on success — the
      // previous page-scoped mounting closed it implicitly on navigation.
      sessionCommittedRef.current = true;
      onClose();
      startNavigation(result.canonicalUrl);
      router.push(result.canonicalUrl);
    } catch (error) {
      submitInFlightRef.current = false;
      if (isSessionOptionsChangedError(error)) {
        invalidateSessionRepositoryCache(workspaceId);
      }
      setErrorMessage(error instanceof Error ? error.message : "Failed to create session.");
      setIsSubmitting(false);
    }
  }

  function handleFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (!isSessionSubmitShortcut(event)) {
      return;
    }

    event.preventDefault();

    if (!isSubmitting) {
      event.currentTarget.requestSubmit();
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isSubmitting && !hasActiveAttachmentOperation) onClose();
      }}
    >
      <DialogContent
        className="max-w-xl"
        description="Link a Linear issue or describe the work, then choose where Wallie should run."
        dismissible={!isSubmitting && !hasActiveAttachmentOperation}
        title="Start a new session"
      >
        <form className="space-y-5" onKeyDown={handleFormKeyDown} onSubmit={handleSubmit}>
          <div className="space-y-4 rounded-[8px] border border-border bg-control-muted/40 p-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="session-linear">
                Linear issue URL
              </label>
              <input
                id="session-linear"
                aria-describedby={
                  [
                    "session-linear-description",
                    linearError ? "session-linear-error" : null,
                    errorMessage ? "create-session-error" : null,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                autoComplete="off"
                autoFocus
                name="linearUrl"
                value={linearUrl}
                onChange={(event) => handleLinearChange(event.target.value)}
                onBlur={handleLinearBlur}
                className="ui-input"
                placeholder="https://linear.app/acme/issue/TEAM-123"
                type="url"
              />
              <p className="type-annotation text-muted" id="session-linear-description">
                Wallie uses the issue title and, when the prompt is empty, its description.
              </p>
              {linearError ? (
                <p className="text-xs text-danger" id="session-linear-error" role="alert">
                  {linearError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="type-annotation text-muted">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="session-prompt">
                Prompt
              </label>
              <textarea
                id="session-prompt"
                aria-describedby={
                  ["session-prompt-description", errorMessage ? "create-session-error" : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                autoComplete="off"
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.items)
                    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => file !== null);
                  if (files.length > 0) handleImageFiles(files);
                }}
                className="ui-textarea min-h-32 leading-6"
                placeholder="What should Wallie build?"
              />
              <p className="type-annotation text-muted" id="session-prompt-description">
                Required only when no Linear issue is linked.
              </p>
              <SessionImageAttachments
                disabled={isSubmitting}
                images={imageDrafts}
                maxImages={maxSessionAttachments}
                onFiles={handleImageFiles}
                onRemove={(clientId) => void handleRemoveImage(clientId)}
                onRetry={handleRetryImage}
              />
              {attachmentMessage ? (
                <p className="text-xs text-warning" role="status">
                  {attachmentMessage}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="session-title">
              Title <span className="type-annotation font-normal text-muted">(optional)</span>
            </label>
            <input
              id="session-title"
              autoComplete="off"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="ui-input"
              disabled={hasLinearIssue}
              placeholder={
                hasLinearIssue
                  ? "From the linked Linear issue"
                  : prompt.trim()
                    ? derivedTitle
                    : "Generated from the prompt"
              }
            />
            {hasLinearIssue ? (
              <p className="type-annotation text-muted">Linear issue titles take precedence.</p>
            ) : null}
          </div>

          <RepositoryField
            cacheKey={repositoryCacheKey}
            onValueChange={setGithubRepositoryId}
            options={repositorySelectOptions}
            selectedGithubRepositoryId={selectedGithubRepositoryId}
            snapshot={repositorySnapshot}
          />

          {repositorySnapshot.data ? (
            <MultiSelectField
              description="Choose the pipeline stages this session should run."
              disabled={isSubmitting || repositorySnapshot.isStale}
              emptyMessage="No pipeline stages are configured."
              error={
                stageOptions.length === 0
                  ? "Workspace pipeline has no stages."
                  : selectedStageIds.length === 0
                    ? "Select at least one stage."
                    : undefined
              }
              id="session-stages"
              label="Stages"
              onValuesChange={(values) => {
                const selected = new Set(values);
                setExcludedStageIds(
                  stageOptions.filter((stage) => !selected.has(stage.id)).map((stage) => stage.id),
                );
              }}
              options={stageOptions.map((stage) => ({
                description: stage.description || undefined,
                label: stage.name,
                value: stage.id,
              }))}
              summary={
                selectedStageIds.length === stageOptions.length
                  ? `All ${stageOptions.length} stages.`
                  : `${selectedStageIds.length} of ${stageOptions.length} stages.`
              }
              values={selectedStageIds}
            />
          ) : repositorySnapshot.isLoading ? (
            <div
              aria-busy="true"
              aria-live="polite"
              className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
              role="status"
            >
              Loading stages…
            </div>
          ) : null}

          {errorMessage ? (
            <div
              aria-live="polite"
              id="create-session-error"
              role="status"
              className="rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger"
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              disabled={isSubmitting || hasActiveAttachmentOperation}
              onClick={onClose}
              className="ui-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              aria-keyshortcuts={SESSION_SUBMIT_KEY_SHORTCUTS}
              disabled={isCreateSessionSubmitDisabled({
                hasRepositoryResult: repositorySnapshot.data !== null,
                hasBlockingAttachments,
                isRepositoryStale: repositorySnapshot.isStale,
                isSubmitting,
                linearUrl,
                prompt,
                selectedStageCount: selectedStageIds.length,
                stageCount: stageOptions.length,
              })}
              className="ui-button-primary"
            >
              <ActionButtonLabel
                idle="Start session"
                pending={isSubmitting}
                pendingLabel="Starting…"
              />
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RepositoryFieldProps = {
  cacheKey: SessionRepositoryCacheKey;
  onValueChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  selectedGithubRepositoryId: string;
  snapshot: SessionRepositorySnapshot;
};

export function RepositoryField({
  cacheKey,
  onValueChange,
  options,
  selectedGithubRepositoryId,
  snapshot,
}: RepositoryFieldProps) {
  function retry() {
    void retrySessionRepositories(cacheKey).catch(() => undefined);
  }

  if (!snapshot.data && snapshot.isLoading) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
        role="status"
      >
        Loading repositories…
      </div>
    );
  }

  if (!snapshot.data && snapshot.error) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
        role="alert"
      >
        <span>{snapshot.error}</span>
        <button className="ui-button min-h-8" onClick={retry} type="button">
          Retry session options
        </button>
      </div>
    );
  }

  if (!snapshot.data) {
    return (
      <div aria-live="polite" className="text-xs text-muted" role="status">
        Preparing repository options…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {options.length > 0 ? (
        <SelectField
          label="Repository"
          options={options}
          onValueChange={onValueChange}
          value={selectedGithubRepositoryId}
        />
      ) : (
        <div
          aria-live="polite"
          className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
          role="status"
        >
          No repositories are available. This session will start without one.
        </div>
      )}

      {snapshot.isStale ? (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
          role={snapshot.error ? "alert" : "status"}
        >
          <span>
            {snapshot.isRefreshing
              ? "Refreshing repository options…"
              : snapshot.error
                ? `Session options may be out of date. ${snapshot.error}`
                : "Session options may be out of date."}
          </span>
          {!snapshot.isRefreshing ? (
            <button className="ui-button min-h-8" onClick={retry} type="button">
              Refresh session options
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
