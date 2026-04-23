"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

import { createSessionFromClient } from "@/features/sessions/client";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type CreateSessionDialogProps = {
  onClose: () => void;
  open: boolean;
  workspaceId: string;
  workspaceSlug: string;
};

const LINEAR_URL_RE = /^https?:\/\/(?:[\w-]+\.)?linear\.app\//i;

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
  workspaceId,
  workspaceSlug,
}: CreateSessionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowserClient());

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [linearUrl, setLinearUrl] = useState("");
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

  const autoTitle = title.trim() || deriveSessionTitleFromPrompt(prompt);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

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
        linearIssueUrl: linearUrl.trim() || null,
        promptMd: prompt.trim(),
        title: title.trim() || null,
        workspaceId,
      });
      router.push(workspaceSessionDetailPath(workspaceSlug, result.number));
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create session.");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overscroll-contain bg-foreground/28 px-4 py-10 backdrop-blur-sm">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-panel-elevated max-h-[calc(100vh-5rem)] w-full max-w-xl overflow-y-auto overscroll-contain p-6"
        role="dialog"
      >
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">New session</p>
          <h2
            id={titleId}
            className="mt-2 text-2xl font-semibold tracking-tight text-balance text-foreground"
          >
            Start a Wallie pipeline
          </h2>
          <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
            Write the prompt. Wallie drafts a product spec and you review before it moves to design.
          </p>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
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
              placeholder="What should Wallie build? The first line becomes the session title."
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
              placeholder={autoTitle || "Auto-filled from the first line of the prompt"}
            />
            {!title.trim() && prompt.trim() ? (
              <p className="text-[11px] text-muted">
                Will be saved as: <span className="font-medium text-foreground">{autoTitle}</span>
              </p>
            ) : null}
          </div>

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
            {linearError ? (
              <p className="text-[11px] text-danger">{linearError}</p>
            ) : (
              <p className="text-[11px] text-muted">
                If provided, Wallie will link this session to the Linear issue.
              </p>
            )}
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
              {isSubmitting ? "Creating…" : "Create session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
