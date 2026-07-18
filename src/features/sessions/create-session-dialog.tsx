"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

import { SelectField } from "@/components/ui/select";
import {
  createSessionFromClient,
  loadSessionRepositoryOptionsFromClient,
} from "@/features/sessions/client";
import {
  deriveSessionTitleFromPrompt,
  type SessionRepositoryOption,
} from "@/features/sessions/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type CreateSessionDialogProps = {
  defaultGithubRepositoryId: string | null;
  onClose: () => void;
  open: boolean;
  workspaceId: string;
  workspaceSlug: string;
};

const LINEAR_URL_RE = /^https?:\/\/(?:[\w-]+\.)?linear\.app\//i;

export function isSessionSubmitShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey">) {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
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
  defaultGithubRepositoryId,
  onClose,
  workspaceId,
}: CreateSessionDialogProps) {
  const titleId = useId();
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowserClient());

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [linearUrl, setLinearUrl] = useState("");
  const [repositoryOptions, setRepositoryOptions] = useState<SessionRepositoryOption[]>([]);
  const [repositoryLoadError, setRepositoryLoadError] = useState<string | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [githubRepositoryId, setGithubRepositoryId] = useState(defaultGithubRepositoryId ?? "");
  const [linearError, setLinearError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    let canceled = false;

    async function loadRepositories() {
      setRepositoryLoading(true);
      setRepositoryLoadError(null);

      try {
        const result = await loadSessionRepositoryOptionsFromClient({ workspaceId });
        if (canceled) return;

        setRepositoryOptions(result.repositoryOptions);
        setGithubRepositoryId((currentRepositoryId) => {
          if (
            currentRepositoryId &&
            result.repositoryOptions.some((repository) => repository.id === currentRepositoryId)
          ) {
            return currentRepositoryId;
          }

          return result.defaultGithubRepositoryId ?? result.repositoryOptions[0]?.id ?? "";
        });
      } catch (error) {
        if (canceled) return;
        setRepositoryLoadError(
          error instanceof Error ? error.message : "Failed to load repositories.",
        );
      } finally {
        if (!canceled) {
          setRepositoryLoading(false);
        }
      }
    }

    void loadRepositories();

    return () => {
      canceled = true;
    };
  }, [workspaceId]);

  function handleLinearBlur() {
    const trimmed = linearUrl.trim();
    if (!trimmed) {
      setLinearError(null);
      return;
    }
    if (!LINEAR_URL_RE.test(trimmed)) {
      setLinearError("Must be a linear.app URL.");
      return;
    }
    setLinearError(null);
  }

  const derivedTitle = deriveSessionTitleFromPrompt(prompt);
  const repositorySelectOptions = repositoryOptions.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
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

    if (!prompt.trim()) {
      setErrorMessage("A prompt is required.");
      return;
    }

    if (linearUrl.trim() && linearError) {
      setErrorMessage("Fix the Linear URL before submitting.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result = await createSessionFromClient(supabase, {
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
      router.push(result.canonicalUrl);
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

          {repositoryOptions.length > 0 ? (
            <SelectField
              label="Repository"
              options={repositorySelectOptions}
              onValueChange={setGithubRepositoryId}
              value={selectedGithubRepositoryId}
            />
          ) : repositoryLoading ? (
            <div className="rounded-[6px] border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted">
              Loading repositories...
            </div>
          ) : repositoryLoadError ? (
            <div className="rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning">
              {repositoryLoadError}
            </div>
          ) : null}

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
              disabled={isSubmitting || !prompt.trim()}
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
