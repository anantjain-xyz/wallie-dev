"use client";

import { useEffect, useId, useState } from "react";

import { createIssueWithAllocatedNumber } from "@/features/issues/client";
import type { IssueMember } from "@/features/issues/types";
import {
  ISSUE_ESTIMATE_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_STATUS_VALUES,
} from "@/features/issues/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type CreateIssueDialogProps = {
  members: IssueMember[];
  onClose: () => void;
  onCreated: (issueNumber: number) => void;
  open: boolean;
  workspaceId: string;
};

const estimateOptions = ISSUE_ESTIMATE_VALUES.filter(
  (estimate) => estimate !== null,
);

export function CreateIssueDialog({
  members,
  onClose,
  onCreated,
  open,
  workspaceId,
}: CreateIssueDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<(typeof ISSUE_STATUS_VALUES)[number]>(
    "backlog",
  );
  const [priority, setPriority] = useState<(typeof ISSUE_PRIORITY_VALUES)[number]>(
    "none",
  );
  const [estimate, setEstimate] = useState<string>("");
  const [assigneeMemberId, setAssigneeMemberId] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setStatus("backlog");
      setPriority("none");
      setEstimate("");
      setAssigneeMemberId("");
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setErrorMessage("Issue title is required.");
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const createdIssue = await createIssueWithAllocatedNumber(supabase, {
        assigneeMemberId: assigneeMemberId || null,
        descriptionMd: description.trim(),
        estimatePoints: estimate ? Number(estimate) : null,
        priority,
        status,
        title: title.trim(),
        workspaceId,
      });

      onCreated(createdIssue.number);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create issue.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overscroll-contain bg-foreground/28 px-4 py-10 backdrop-blur-sm">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-panel-elevated max-h-[calc(100vh-5rem)] w-full max-w-2xl overflow-y-auto overscroll-contain p-6"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium text-muted">
              Create Issue
            </p>
            <h2
              id={titleId}
              className="mt-2 text-2xl font-semibold tracking-tight text-balance text-foreground"
            >
              New Workspace Issue
            </h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
              Capture the issue title, the optional Markdown context, and the
              initial owner before Wallie opens the new detail route.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-button"
          >
            Close
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-foreground" htmlFor="issue-title">
              Title
            </label>
            <input
              id="issue-title"
              autoComplete="off"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="ui-input"
              placeholder="Document Gate D Completion Checklist…"
            />
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-semibold text-foreground"
              htmlFor="issue-description"
            >
              Description
            </label>
            <textarea
              id="issue-description"
              autoComplete="off"
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="ui-textarea min-h-36 leading-6"
              placeholder="Add context, acceptance criteria, or notes in Markdown…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Status</span>
              <select
                name="status"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as (typeof ISSUE_STATUS_VALUES)[number])
                }
                className="ui-select"
              >
                {ISSUE_STATUS_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Priority</span>
              <select
                name="priority"
                value={priority}
                onChange={(event) =>
                  setPriority(
                    event.target.value as (typeof ISSUE_PRIORITY_VALUES)[number],
                  )
                }
                className="ui-select"
              >
                {ISSUE_PRIORITY_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Estimate</span>
              <select
                name="estimate"
                value={estimate}
                onChange={(event) => setEstimate(event.target.value)}
                className="ui-select"
              >
                <option value="">No estimate</option>
                {estimateOptions.map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "point" : "points"}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Assignee</span>
              <select
                name="assigneeMemberId"
                value={assigneeMemberId}
                onChange={(event) => setAssigneeMemberId(event.target.value)}
                className="ui-select"
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName ?? member.username ?? "Unknown member"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {errorMessage ? (
            <div
              aria-live="polite"
              role="status"
              className="rounded-[12px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger"
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="ui-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="ui-button-primary"
            >
              {isSubmitting ? "Creating…" : "Create & Open"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
