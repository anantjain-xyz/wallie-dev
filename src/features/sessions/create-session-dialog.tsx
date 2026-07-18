"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

import { SelectField } from "@/components/ui/select";
import { createSessionFromClient } from "@/features/sessions/client";
import {
  preloadSessionRepositories as preloadSessionRepositoryCache,
  retrySessionRepositories,
  useSessionRepositories,
  type SessionRepositoryCacheKey,
  type SessionRepositorySnapshot,
} from "@/features/sessions/session-repository-cache";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";

type CreateSessionDialogProps = {
  onClose: () => void;
  open: boolean;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
};

const LINEAR_URL_RE = /^https?:\/\/(?:[\w-]+\.)?linear\.app\//i;

export function isSessionSubmitShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey">) {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
}

export function getLinearUrlError(value: string) {
  const trimmed = value.trim();
  if (!trimmed || LINEAR_URL_RE.test(trimmed)) {
    return null;
  }

  return "Must be a linear.app URL.";
}

export function preloadSessionRepositories(input: SessionRepositoryCacheKey) {
  return preloadSessionRepositoryCache(input);
}

export function isCreateSessionSubmitDisabled(input: {
  hasRepositoryResult: boolean;
  isSubmitting: boolean;
  prompt: string;
}) {
  return input.isSubmitting || !input.prompt.trim() || !input.hasRepositoryResult;
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

function CreateSessionDialogBody({
  onClose,
  userId,
  workspaceId,
  workspaceSlug,
}: CreateSessionDialogProps) {
  const titleId = useId();
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [linearUrl, setLinearUrl] = useState("");
  const [githubRepositoryId, setGithubRepositoryId] = useState("");
  const [linearError, setLinearError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const repositoryCacheKey = { userId, workspaceId };
  const repositorySnapshot = useSessionRepositories(repositoryCacheKey);
  const repositoryOptions = repositorySnapshot.data?.repositoryOptions ?? [];

  function handleLinearBlur() {
    setLinearError(getLinearUrlError(linearUrl));
  }

  const derivedTitle = deriveSessionTitleFromPrompt(prompt);
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

    if (isSubmitting) {
      return;
    }

    if (!repositorySnapshot.data) {
      setErrorMessage("Wait for repositories to finish loading before starting a session.");
      return;
    }

    if (!prompt.trim()) {
      setErrorMessage("A prompt is required.");
      return;
    }

    const nextLinearError = getLinearUrlError(linearUrl);
    if (nextLinearError) {
      setLinearError(nextLinearError);
      setErrorMessage("Fix the Linear URL before submitting.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result = await createSessionFromClient({
        githubRepositoryId: selectedGithubRepositoryId || null,
        linearIssueUrl: linearUrl.trim() || null,
        promptMd: prompt.trim(),
        title: title.trim() || null,
        workspaceId,
      });
      // The dialog now lives in the workspace shell (stays mounted across
      // route changes), so we must explicitly close it on success — the
      // previous page-scoped mounting closed it implicitly on navigation.
      onClose();
      router.push(workspaceSessionDetailPath(workspaceSlug, result.number));
      router.refresh();
    } catch (error) {
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
    <div className="fixed inset-0 isolate z-50 flex items-start justify-center overscroll-contain bg-foreground/28 px-4 py-4 backdrop-blur-sm sm:py-10">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-panel-elevated relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto overscroll-contain bg-surface p-5 sm:max-h-[calc(100dvh-5rem)] sm:p-6"
        role="dialog"
      >
        <div>
          <h2
            id={titleId}
            className="text-2xl font-semibold tracking-tight text-balance text-foreground"
          >
            Start a new session
          </h2>
        </div>

        <form className="mt-6 space-y-5" onKeyDown={handleFormKeyDown} onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="session-prompt">
              Prompt
            </label>
            <textarea
              id="session-prompt"
              autoComplete="off"
              autoFocus
              name="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="ui-textarea min-h-40 leading-6"
              placeholder="What should Wallie build?"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="session-title">
              Title <span className="text-[11px] font-normal text-muted">(optional)</span>
            </label>
            <input
              id="session-title"
              autoComplete="off"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="ui-input"
              placeholder={prompt.trim() ? derivedTitle : "Generated from the prompt"}
            />
          </div>

          <RepositoryField
            cacheKey={repositoryCacheKey}
            onValueChange={setGithubRepositoryId}
            options={repositorySelectOptions}
            selectedGithubRepositoryId={selectedGithubRepositoryId}
            snapshot={repositorySnapshot}
          />

          <div className="space-y-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="session-linear">
              Linear issue URL{" "}
              <span className="text-[11px] font-normal text-muted">(optional)</span>
            </label>
            <input
              id="session-linear"
              autoComplete="off"
              name="linearUrl"
              value={linearUrl}
              onChange={(event) => setLinearUrl(event.target.value)}
              onBlur={handleLinearBlur}
              className="ui-input"
              placeholder="https://linear.app/acme/issue/TEAM-123"
              type="url"
            />
            {linearError ? <p className="text-[11px] text-danger">{linearError}</p> : null}
          </div>

          {errorMessage ? (
            <div
              aria-live="polite"
              role="status"
              className="rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger"
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="ui-button">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isCreateSessionSubmitDisabled({
                hasRepositoryResult: repositorySnapshot.data !== null,
                isSubmitting,
                prompt,
              })}
              className="ui-button-primary"
            >
              {isSubmitting ? "Starting…" : "Start session"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
        className="rounded-[6px] border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted"
        role="status"
      >
        Loading repositories…
      </div>
    );
  }

  if (!snapshot.data && snapshot.error) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning"
        role="alert"
      >
        <span>{snapshot.error}</span>
        <button className="ui-button min-h-8" onClick={retry} type="button">
          Retry repositories
        </button>
      </div>
    );
  }

  if (!snapshot.data) {
    return (
      <div aria-live="polite" className="text-[12px] text-muted" role="status">
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
          className="rounded-[6px] border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted"
          role="status"
        >
          No repositories are available. This session will start without one.
        </div>
      )}

      {snapshot.isStale ? (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning"
          role={snapshot.error ? "alert" : "status"}
        >
          <span>
            {snapshot.isRefreshing
              ? "Refreshing repository options…"
              : snapshot.error
                ? `Repository options may be out of date. ${snapshot.error}`
                : "Repository options may be out of date."}
          </span>
          {!snapshot.isRefreshing ? (
            <button className="ui-button min-h-8" onClick={retry} type="button">
              Refresh repositories
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
