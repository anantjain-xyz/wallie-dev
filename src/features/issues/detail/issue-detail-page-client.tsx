"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";

import type { Tables, TablesUpdate } from "@/lib/supabase/database.types";
import { createIssueWithAllocatedNumber, resolveIssueByNumber } from "@/features/issues/client";
import type { IssueDetailPageData } from "@/features/issues/detail/data";
import { buildIssueMarkdown } from "@/features/issues/detail/markdown";
import { groupIssueLinks } from "@/features/issues/detail/relationships";
import { IssueWalliePanel } from "@/features/wallie/issue-wallie-panel";
import {
  buildIssueMemberIndex,
  mapIssueCommentRow,
  mapIssueDetailRow,
  mapIssueRow,
} from "@/features/issues/model";
import {
  IssueEstimateBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
} from "@/features/issues/ui";
import {
  ISSUE_ESTIMATE_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_STATUS_VALUES,
  formatIssueEstimate,
  formatIssueStatus,
  isWorkspaceManager,
  type IssueComment,
  type IssueDetail,
  type IssueMember,
  type IssueStatus,
} from "@/features/issues/types";
import {
  PriorityBarIcon,
  StatusBacklogIcon,
  StatusCanceledIcon,
  StatusDoneIcon,
  StatusInProgressIcon,
  StatusInReviewIcon,
  StatusTodoIcon,
} from "@/components/shared/icons";
import { workspaceIssueDetailPath, workspaceSettingsPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

type IssueDetailPageClientProps = {
  initialData: IssueDetailPageData;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function formatRelativeTime(dateString: string) {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = then - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.round(diffMs / (1000 * 60));

  if (Math.abs(diffDays) >= 7) {
    const diffWeeks = Math.round(diffDays / 7);
    return relativeTimeFormatter.format(diffWeeks, "week");
  }
  if (Math.abs(diffDays) >= 1) {
    return relativeTimeFormatter.format(diffDays, "day");
  }
  if (Math.abs(diffHours) >= 1) {
    return relativeTimeFormatter.format(diffHours, "hour");
  }
  return relativeTimeFormatter.format(diffMinutes, "minute");
}

function StatusIcon({ status }: { status: IssueStatus }) {
  switch (status) {
    case "backlog":
      return <StatusBacklogIcon />;
    case "todo":
      return <StatusTodoIcon />;
    case "in_progress":
      return <StatusInProgressIcon />;
    case "in_review":
      return <StatusInReviewIcon />;
    case "done":
      return <StatusDoneIcon />;
    case "canceled":
      return <StatusCanceledIcon />;
  }
}

function mapPullRequestRow(
  row: Tables<"github_issue_branches">,
  repositoryIndex: ReadonlyMap<string, IssueDetailPageData["github"]["repositories"][number]>,
) {
  return {
    branchName: row.branch_name,
    createdAt: row.created_at,
    githubRepositoryId: row.github_repository_id,
    id: row.id,
    isDraft: row.is_draft,
    pullRequestNumber: row.pull_request_number,
    pullRequestState: row.pull_request_state,
    pullRequestUrl: row.pull_request_url,
    repository: row.github_repository_id
      ? (repositoryIndex.get(row.github_repository_id) ?? null)
      : null,
    updatedAt: row.updated_at,
  };
}

function PropertyRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="group flex min-h-[32px] items-center rounded-[4px] px-2 transition-colors duration-100 hover:bg-surface-muted">
      <span className="w-[100px] shrink-0 text-[13px] text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SidebarHeading({ title }: { title: string }) {
  return (
    <h3 className="mb-1 px-2 pt-4 text-[11px] font-medium uppercase tracking-[0.05em] text-muted first:pt-0">
      {title}
    </h3>
  );
}

function messageToneClass(kind: "error" | "success") {
  return kind === "error"
    ? "border-danger/20 bg-danger-soft text-danger"
    : "border-success/20 bg-success-soft text-success";
}

const interactiveLinkClass =
  "font-medium text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

function buildMemberIndex(
  members: IssueMember[],
  issue: IssueDetail,
  comments: IssueComment[],
  linkedIssues: IssueDetailPageData["linkedIssues"],
  currentMember: IssueDetailPageData["currentMember"],
) {
  return buildIssueMemberIndex(
    [
      ...members,
      issue.assignee,
      issue.creator,
      currentMember,
      ...comments.flatMap((comment) => [comment.author]),
      ...linkedIssues.flatMap((linkedIssue) => [linkedIssue.assignee, linkedIssue.creator]),
    ].filter((member): member is IssueMember => member !== null),
  );
}

function relationExists(
  links: IssueDetailPageData["links"],
  sourceIssueId: string,
  targetIssueId: string,
  linkType: IssueDetailPageData["links"][number]["link_type"],
  symmetric = false,
) {
  return links.some((link) => {
    if (link.link_type !== linkType) {
      return false;
    }

    if (symmetric) {
      return (
        (link.source_issue_id === sourceIssueId && link.target_issue_id === targetIssueId) ||
        (link.source_issue_id === targetIssueId && link.target_issue_id === sourceIssueId)
      );
    }

    return link.source_issue_id === sourceIssueId && link.target_issue_id === targetIssueId;
  });
}

export function IssueDetailPageClient({ initialData }: IssueDetailPageClientProps) {
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [issue, setIssue] = useState(initialData.issue);
  const [comments, setComments] = useState(initialData.comments);
  const [links, setLinks] = useState(initialData.links);
  const [linkedIssues, setLinkedIssues] = useState(initialData.linkedIssues);
  const [pullRequests, setPullRequests] = useState(initialData.github.pullRequests);
  const [titleDraft, setTitleDraft] = useState(initialData.issue.title);
  const [descriptionDraft, setDescriptionDraft] = useState(initialData.issue.descriptionMd);
  const [planDraft, setPlanDraft] = useState(initialData.issue.planMd ?? "");
  const [designDraft, setDesignDraft] = useState(initialData.issue.designMd ?? "");
  const [newCommentBody, setNewCommentBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [parentIssueNumber, setParentIssueNumber] = useState("");
  const [subIssueNumber, setSubIssueNumber] = useState("");
  const [newSubIssueTitle, setNewSubIssueTitle] = useState("");
  const [newSubIssueEstimate, setNewSubIssueEstimate] = useState("");
  const [blockedByNumber, setBlockedByNumber] = useState("");
  const [blocksNumber, setBlocksNumber] = useState("");
  const [duplicateNumber, setDuplicateNumber] = useState("");
  const [relatedNumber, setRelatedNumber] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const hasUnsavedChanges =
    titleDraft.trim() !== issue.title ||
    descriptionDraft !== issue.descriptionMd ||
    planDraft !== (issue.planMd ?? "") ||
    designDraft !== (issue.designMd ?? "") ||
    newCommentBody.trim().length > 0 ||
    editingCommentId !== null ||
    parentIssueNumber.trim().length > 0 ||
    subIssueNumber.trim().length > 0 ||
    newSubIssueTitle.trim().length > 0 ||
    newSubIssueEstimate !== "" ||
    blockedByNumber.trim().length > 0 ||
    blocksNumber.trim().length > 0 ||
    duplicateNumber.trim().length > 0 ||
    relatedNumber.trim().length > 0;

  useEffect(() => {
    setIssue(initialData.issue);
    setComments(initialData.comments);
    setLinks(initialData.links);
    setLinkedIssues(initialData.linkedIssues);
    setPullRequests(initialData.github.pullRequests);
  }, [
    initialData.comments,
    initialData.github.pullRequests,
    initialData.issue,
    initialData.linkedIssues,
    initialData.links,
  ]);

  useEffect(() => {
    setTitleDraft(issue.title);
    setDescriptionDraft(issue.descriptionMd);
    setPlanDraft(issue.planMd ?? "");
    setDesignDraft(issue.designMd ?? "");
  }, [issue]);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  const currentMember = initialData.currentMember;
  const canManage = isWorkspaceManager(currentMember);
  const repositoryIndex = new Map(
    initialData.github.repositories.map((repository) => [repository.id, repository]),
  );
  const memberIndex = buildMemberIndex(
    initialData.members,
    issue,
    comments,
    linkedIssues,
    currentMember,
  );
  const linkedIssueIndex = new Map(
    linkedIssues.map((linkedIssue) => [linkedIssue.id, linkedIssue]),
  );
  const relationshipGroups = groupIssueLinks(issue.id, links, linkedIssueIndex);
  const handleIssueRealtimeUpdate = useEffectEvent((row: Tables<"issues">) => {
    setIssue(mapIssueDetailRow(row, memberIndex));
  });
  const handlePullRequestRealtimeUpdate = useEffectEvent((row: Tables<"github_issue_branches">) => {
    const nextPullRequest = mapPullRequestRow(row, repositoryIndex);

    setPullRequests((currentPullRequests) => {
      const nextPullRequests = currentPullRequests.filter(
        (pullRequest) => pullRequest.id !== nextPullRequest.id,
      );

      nextPullRequests.unshift(nextPullRequest);
      nextPullRequests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      return nextPullRequests;
    });
  });

  useEffect(() => {
    const issueChannel = supabase
      .channel(`issue-detail:${issue.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          filter: `id=eq.${issue.id}`,
          schema: "public",
          table: "issues",
        },
        (payload) => {
          handleIssueRealtimeUpdate(payload.new as Tables<"issues">);
        },
      )
      .subscribe();
    const pullRequestChannel = supabase
      .channel(`issue-prs:${issue.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `issue_id=eq.${issue.id}`,
          schema: "public",
          table: "github_issue_branches",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setPullRequests((currentPullRequests) =>
              currentPullRequests.filter((pullRequest) => pullRequest.id !== payload.old.id),
            );
            return;
          }

          handlePullRequestRealtimeUpdate(payload.new as Tables<"github_issue_branches">);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(issueChannel);
      void supabase.removeChannel(pullRequestChannel);
    };
  }, [issue.id, supabase]);

  async function saveIssuePatch(patch: TablesUpdate<"issues">) {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { data, error } = await supabase
        .from("issues")
        .update(patch)
        .eq("id", issue.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      setIssue(mapIssueDetailRow(data, memberIndex));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Issue update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createComment() {
    if (!newCommentBody.trim()) {
      setErrorMessage("Comment body is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { data, error } = await supabase
        .from("issue_comments")
        .insert({
          body_md: newCommentBody.trim(),
          issue_id: issue.id,
          workspace_id: issue.workspaceId,
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      setComments((currentComments) => [...currentComments, mapIssueCommentRow(data, memberIndex)]);
      setNewCommentBody("");
      setSuccessMessage("Comment added.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Comment creation failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveComment(commentId: string) {
    if (!editingCommentBody.trim()) {
      setErrorMessage("Comment body is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { data, error } = await supabase
        .from("issue_comments")
        .update({
          body_md: editingCommentBody.trim(),
        })
        .eq("id", commentId)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      const nextComment = mapIssueCommentRow(data, memberIndex);

      setComments((currentComments) =>
        currentComments.map((comment) => (comment.id === nextComment.id ? nextComment : comment)),
      );
      setEditingCommentId(null);
      setEditingCommentBody("");
      setSuccessMessage("Comment updated.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Comment update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteComment(commentId: string) {
    if (!window.confirm("Delete this comment?")) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { error } = await supabase.from("issue_comments").delete().eq("id", commentId);

      if (error) {
        throw error;
      }

      setComments((currentComments) =>
        currentComments.filter((comment) => comment.id !== commentId),
      );
      setSuccessMessage("Comment deleted.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Comment deletion failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function addRelationship(options: {
    issueNumber: string;
    linkType: IssueDetailPageData["links"][number]["link_type"];
    reverse?: boolean;
    symmetric?: boolean;
    successLabel: string;
  }) {
    const targetIssueNumber = Number(options.issueNumber);

    if (!Number.isInteger(targetIssueNumber) || targetIssueNumber < 1) {
      setErrorMessage("Enter a valid issue number.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const targetIssue = await resolveIssueByNumber(
        supabase,
        issue.workspaceId,
        targetIssueNumber,
      );

      if (!targetIssue) {
        throw new Error(`Issue #${targetIssueNumber} was not found.`);
      }

      if (targetIssue.id === issue.id) {
        throw new Error("Issue links cannot point back to the same issue.");
      }

      const sourceIssueId = options.reverse ? targetIssue.id : issue.id;
      const targetIssueId = options.reverse ? issue.id : targetIssue.id;

      if (
        options.linkType === "sub_issue" &&
        !options.reverse &&
        relationshipGroups.parentIssues.length > 0 &&
        !relationExists(links, sourceIssueId, targetIssueId, "sub_issue")
      ) {
        throw new Error(
          "Gate D exposes one parent issue at a time. Remove the current parent before setting a new one.",
        );
      }

      if (
        relationExists(links, sourceIssueId, targetIssueId, options.linkType, options.symmetric)
      ) {
        throw new Error("That relationship already exists.");
      }

      const { data, error } = await supabase
        .from("issue_links")
        .insert({
          link_type: options.linkType,
          source_issue_id: sourceIssueId,
          target_issue_id: targetIssueId,
          workspace_id: issue.workspaceId,
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      setLinks((currentLinks) => [...currentLinks, data]);

      if (!linkedIssueIndex.has(targetIssue.id)) {
        setLinkedIssues((currentIssues) => [
          ...currentIssues,
          mapIssueRow(targetIssue, memberIndex),
        ]);
      }

      setSuccessMessage(options.successLabel);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Relationship update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createSubIssue() {
    if (!newSubIssueTitle.trim()) {
      setErrorMessage("Sub-issue title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const createdIssue = await createIssueWithAllocatedNumber(supabase, {
        estimatePoints: newSubIssueEstimate ? Number(newSubIssueEstimate) : null,
        title: newSubIssueTitle.trim(),
        workspaceId: issue.workspaceId,
      });
      const { data: link, error: linkError } = await supabase
        .from("issue_links")
        .insert({
          link_type: "sub_issue",
          source_issue_id: createdIssue.id,
          target_issue_id: issue.id,
          workspace_id: issue.workspaceId,
        })
        .select("*")
        .single();

      if (linkError) {
        throw linkError;
      }

      const mappedIssue = mapIssueRow(createdIssue, memberIndex);

      setLinkedIssues((currentIssues) => [...currentIssues, mappedIssue]);
      setLinks((currentLinks) => [...currentLinks, link]);
      setNewSubIssueTitle("");
      setNewSubIssueEstimate("");
      setSuccessMessage(`Created sub-issue #${createdIssue.number}.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Sub-issue creation failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function removeLink(linkId: string) {
    if (!window.confirm("Remove this relationship?")) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { error } = await supabase.from("issue_links").delete().eq("id", linkId);

      if (error) {
        throw error;
      }

      setLinks((currentLinks) => currentLinks.filter((link) => link.id !== linkId));
      setSuccessMessage("Relationship removed.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Relationship removal failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function copyAsMarkdown() {
    setIsCopying(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await navigator.clipboard.writeText(
        buildIssueMarkdown(initialData.workspace.slug, issue, comments),
      );
      setSuccessMessage("Issue copied as Markdown.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Clipboard copy failed.");
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <div>
      {/* ── Breadcrumb header ── */}
      <header className="sticky top-0 z-10 flex h-11 items-center gap-1.5 border-b border-border bg-surface px-4">
        <span className="text-[13px] font-medium text-muted">
          #{issue.number}
        </span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-muted/50">
          <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <h1 className="min-w-0 truncate text-[13px] font-medium text-foreground">
          {issue.title}
        </h1>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void copyAsMarkdown()}
            disabled={isCopying}
            className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium text-muted transition-colors duration-100 hover:bg-surface-muted hover:text-foreground"
            title="Copy as Markdown"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
              <rect x="5" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M3 5.5v7a1.5 1.5 0 0 0 1.5 1.5H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            {isCopying ? "Copying…" : "Copy"}
          </button>
          <Link
            href={workspaceIssueDetailPath(initialData.workspace.slug, issue.number)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium text-muted transition-colors duration-100 hover:bg-surface-muted hover:text-foreground"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
              <path d="M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="m10.5 5.5 2.5 2.5-2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      </header>

      {/* ── Toast messages ── */}
      {errorMessage ? (
        <div
          aria-live="polite"
          className={cn("border-b px-4 py-2.5 text-[13px]", messageToneClass("error"))}
          role="status"
        >
          {errorMessage}
        </div>
      ) : null}
      {successMessage ? (
        <div
          aria-live="polite"
          className={cn("border-b px-4 py-2.5 text-[13px]", messageToneClass("success"))}
          role="status"
        >
          {successMessage}
        </div>
      ) : null}

      {/* ── Two-column body ── */}
      <div className="flex items-start">
        {/* ── Main content ── */}
        <div className="min-w-0 flex-1">
          <div className="mx-auto max-w-[720px] px-10 py-8 xl:px-16">
            {/* Title */}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (titleDraft.trim() && titleDraft.trim() !== issue.title) {
                  void saveIssuePatch({ title: titleDraft.trim() });
                }
              }}
            >
              <input
                id="issue-title"
                autoComplete="off"
                name="title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                className="w-full border-none bg-transparent text-[22px] font-semibold tracking-[-0.02em] text-foreground placeholder:text-muted/60 focus:outline-none"
                placeholder="Issue title"
              />
              {titleDraft.trim() !== issue.title && titleDraft.trim() ? (
                <div className="mt-2 flex items-center gap-2">
                  <button type="submit" disabled={isSaving} className="ui-button text-[12px]">
                    Save
                  </button>
                  <button
                    type="button"
                    className="text-[12px] text-muted hover:text-foreground"
                    onClick={() => setTitleDraft(issue.title)}
                  >
                    Discard
                  </button>
                </div>
              ) : null}
            </form>

            {/* Metadata chips */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>{dateTimeFormatter.format(new Date(issue.createdAt))}</span>
              <span className="text-border-strong">·</span>
              <span>Updated {formatRelativeTime(issue.updatedAt)}</span>
              {issue.creator ? (
                <>
                  <span className="text-border-strong">·</span>
                  <span>{issue.creator.fullName ?? issue.creator.username}</span>
                </>
              ) : null}
            </div>

            {/* ── Description ── */}
            <div className="mt-8">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (descriptionDraft !== issue.descriptionMd) {
                    void saveIssuePatch({ description_md: descriptionDraft });
                  }
                }}
              >
                <textarea
                  id="issue-description"
                  aria-label="Issue Description"
                  autoComplete="off"
                  name="description"
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  className="issue-textarea min-h-[140px]"
                  placeholder="Add description…"
                />
                {descriptionDraft !== issue.descriptionMd ? (
                  <div className="mt-2 flex items-center gap-2">
                    <button type="submit" disabled={isSaving} className="ui-button text-[12px]">
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-muted hover:text-foreground"
                      onClick={() => setDescriptionDraft(issue.descriptionMd)}
                    >
                      Discard
                    </button>
                  </div>
                ) : null}
              </form>
            </div>

            {/* ── Plan ── */}
            <div className="mt-8">
              <h2 className="mb-2 text-[13px] font-medium text-muted">Plan</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (planDraft !== (issue.planMd ?? "")) {
                    void saveIssuePatch({ plan_md: planDraft.trim() ? planDraft : null });
                  }
                }}
              >
                <textarea
                  id="issue-plan"
                  aria-label="Execution Plan"
                  autoComplete="off"
                  name="plan"
                  value={planDraft}
                  onChange={(event) => setPlanDraft(event.target.value)}
                  className="issue-textarea min-h-[120px]"
                  placeholder="Add execution plan…"
                />
                {planDraft !== (issue.planMd ?? "") ? (
                  <div className="mt-2 flex items-center gap-2">
                    <button type="submit" disabled={isSaving} className="ui-button text-[12px]">
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-muted hover:text-foreground"
                      onClick={() => setPlanDraft(issue.planMd ?? "")}
                    >
                      Discard
                    </button>
                  </div>
                ) : null}
              </form>
            </div>

            {/* ── Design ── */}
            <div className="mt-8">
              <h2 className="mb-2 text-[13px] font-medium text-muted">Design</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (designDraft !== (issue.designMd ?? "")) {
                    void saveIssuePatch({ design_md: designDraft.trim() ? designDraft : null });
                  }
                }}
              >
                <textarea
                  id="issue-design"
                  aria-label="Design Notes"
                  autoComplete="off"
                  name="design"
                  value={designDraft}
                  onChange={(event) => setDesignDraft(event.target.value)}
                  className="issue-textarea min-h-[120px]"
                  placeholder="Add design notes…"
                />
                {designDraft !== (issue.designMd ?? "") ? (
                  <div className="mt-2 flex items-center gap-2">
                    <button type="submit" disabled={isSaving} className="ui-button text-[12px]">
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-muted hover:text-foreground"
                      onClick={() => setDesignDraft(issue.designMd ?? "")}
                    >
                      Discard
                    </button>
                  </div>
                ) : null}
              </form>
            </div>

            {/* ── Sub-issues ── */}
            {(relationshipGroups.subIssues.length > 0 || newSubIssueTitle || subIssueNumber) ? (
              <div className="mt-8">
                <h2 className="mb-3 text-[13px] font-medium text-muted">Sub-issues</h2>
                <div className="space-y-1">
                  {relationshipGroups.subIssues.map((subIssueEntry) => (
                    <div
                      key={subIssueEntry.linkId}
                      className="group flex items-center gap-2.5 rounded-[5px] px-2 py-1.5 transition-colors duration-100 hover:bg-surface-muted"
                    >
                      <StatusIcon status={subIssueEntry.issue.status} />
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          subIssueEntry.issue.number,
                        )}
                        className="min-w-0 flex-1 truncate text-[13px] text-foreground hover:text-accent"
                      >
                        <span className="text-muted">#{subIssueEntry.issue.number}</span>{" "}
                        {subIssueEntry.issue.title}
                      </Link>
                      <IssuePriorityBadge priority={subIssueEntry.issue.priority} />
                      <button
                        type="button"
                        onClick={() => void removeLink(subIssueEntry.linkId)}
                        className="hidden text-[11px] text-muted hover:text-danger group-hover:inline-flex"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Activity / Comments ── */}
            <div className="mt-10 border-t border-border pt-6">
              <h2 className="mb-4 text-[13px] font-medium text-muted">Activity</h2>

              {/* Timeline */}
              <div className="space-y-4">
                {/* Created event */}
                <div className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-muted">
                    {(issue.creator?.fullName ?? issue.creator?.username ?? "?")[0]?.toUpperCase()}
                  </div>
                  <div className="pt-0.5 text-[13px] text-muted">
                    <span className="font-medium text-foreground">
                      {issue.creator?.fullName ?? issue.creator?.username ?? "Unknown"}
                    </span>{" "}
                    created the issue{" "}
                    <span className="text-muted" title={dateTimeFormatter.format(new Date(issue.createdAt))}>
                      {formatRelativeTime(issue.createdAt)}
                    </span>
                  </div>
                </div>

                {/* Comments */}
                {comments.map((comment) => {
                  const editable = comment.authorMemberId === currentMember?.id || canManage;
                  const authorName =
                    comment.author?.fullName ?? comment.author?.username ?? "Unknown";

                  return (
                    <div key={comment.id} className="flex items-start gap-3">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">
                        {authorName[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13px] font-medium text-foreground">
                            {authorName}
                          </span>
                          <span className="text-[12px] text-muted" title={dateTimeFormatter.format(new Date(comment.createdAt))}>
                            {formatRelativeTime(comment.createdAt)}
                            {comment.updatedAt !== comment.createdAt ? " · edited" : ""}
                          </span>
                          {editable ? (
                            <div className="ml-auto flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditingCommentBody(comment.bodyMd);
                                }}
                                className="text-[11px] text-muted hover:text-foreground"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteComment(comment.id)}
                                className="text-[11px] text-muted hover:text-danger"
                              >
                                Delete
                              </button>
                            </div>
                          ) : null}
                        </div>

                        {editingCommentId === comment.id ? (
                          <div className="mt-2 space-y-2">
                            <textarea
                              aria-label="Edit Comment"
                              autoComplete="off"
                              name="editingComment"
                              value={editingCommentBody}
                              onChange={(event) => setEditingCommentBody(event.target.value)}
                              className="issue-textarea min-h-[80px]"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void saveComment(comment.id)}
                                disabled={isSaving}
                                className="ui-button-primary text-[12px]"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCommentId(null);
                                  setEditingCommentBody("");
                                }}
                                className="text-[12px] text-muted hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.65] text-foreground/90">
                            {comment.bodyMd}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* New comment form */}
              <div className="mt-6">
                <div className="rounded-[8px] border border-border bg-surface transition-[border-color,box-shadow] duration-150 focus-within:border-accent/30 focus-within:shadow-[0_0_0_3px_rgba(94,106,210,0.08)]">
                  <textarea
                    id="new-comment"
                    autoComplete="off"
                    name="newComment"
                    value={newCommentBody}
                    onChange={(event) => setNewCommentBody(event.target.value)}
                    className="w-full resize-none rounded-t-[8px] border-none bg-transparent px-3 py-2.5 text-[13px] leading-[1.65] text-foreground placeholder:text-muted/60 focus:outline-none"
                    placeholder="Leave a comment…"
                    rows={3}
                  />
                  <div className="flex items-center justify-end border-t border-border/50 px-2 py-1.5">
                    <button
                      type="button"
                      disabled={isSaving || !newCommentBody.trim()}
                      onClick={() => void createComment()}
                      className="inline-flex h-7 items-center rounded-[5px] bg-foreground px-3 text-[12px] font-medium text-accent-foreground transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
                    >
                      Comment
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Wallie Timeline ── */}
            <div className="mt-10 border-t border-border pt-6">
              <h2 className="mb-4 text-[13px] font-medium text-muted">Wallie</h2>
              <IssueWalliePanel
                initialData={initialData.wallie}
                issue={issue}
                memberIndex={memberIndex}
                repositories={initialData.github.repositories}
                supabase={supabase}
                workspaceSlug={initialData.workspace.slug}
              />
            </div>
          </div>
        </div>

        {/* ── Properties sidebar ── */}
        <aside className="sticky top-[44px] hidden h-[calc(100vh-44px)] w-[272px] shrink-0 overflow-y-auto border-l border-border lg:block">
          <div className="px-3 py-4">
            {/* Properties */}
            <SidebarHeading title="Properties" />
            <div>
              <PropertyRow label="Status">
                <div className="flex items-center gap-1.5">
                  <StatusIcon status={issue.status} />
                  <select
                    value={issue.status}
                    onChange={(event) =>
                      void saveIssuePatch({ status: event.target.value as IssueStatus })
                    }
                    className="sidebar-select"
                  >
                    {ISSUE_STATUS_VALUES.map((status) => (
                      <option key={status} value={status}>
                        {formatIssueStatus(status)}
                      </option>
                    ))}
                  </select>
                </div>
              </PropertyRow>

              <PropertyRow label="Priority">
                <div className="flex items-center gap-1.5">
                  <PriorityBarIcon priority={issue.priority} />
                  <select
                    value={issue.priority}
                    onChange={(event) =>
                      void saveIssuePatch({
                        priority: event.target.value as IssueDetail["priority"],
                      })
                    }
                    className="sidebar-select capitalize"
                  >
                    {ISSUE_PRIORITY_VALUES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </div>
              </PropertyRow>

              <PropertyRow label="Assignee">
                <select
                  value={issue.assigneeMemberId ?? ""}
                  onChange={(event) =>
                    void saveIssuePatch({ assignee_member_id: event.target.value || null })
                  }
                  className="sidebar-select"
                >
                  <option value="">Unassigned</option>
                  {initialData.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.fullName ?? member.username ?? "Unknown member"}
                    </option>
                  ))}
                </select>
              </PropertyRow>

              <PropertyRow label="Estimate">
                <select
                  value={issue.estimatePoints === null ? "null" : String(issue.estimatePoints)}
                  onChange={(event) =>
                    void saveIssuePatch({
                      estimate_points:
                        event.target.value === "null" ? null : Number(event.target.value),
                    })
                  }
                  className="sidebar-select"
                >
                  {ISSUE_ESTIMATE_VALUES.map((estimate) => (
                    <option
                      key={estimate === null ? "null" : estimate}
                      value={estimate === null ? "null" : String(estimate)}
                    >
                      {formatIssueEstimate(estimate)}
                    </option>
                  ))}
                </select>
              </PropertyRow>

              <PropertyRow label="Repository">
                <select
                  value={issue.githubRepositoryId ?? ""}
                  onChange={(event) =>
                    void saveIssuePatch({ github_repository_id: event.target.value || null })
                  }
                  className="sidebar-select"
                >
                  <option value="">None</option>
                  {initialData.github.repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.fullName}
                    </option>
                  ))}
                </select>
              </PropertyRow>
            </div>

            {issue.githubRepositoryId && repositoryIndex.get(issue.githubRepositoryId) ? (
              <div className="mt-1 px-2">
                <a
                  href={repositoryIndex.get(issue.githubRepositoryId)?.htmlUrl}
                  rel="noreferrer"
                  target="_blank"
                  className={cn("text-[12px]", interactiveLinkClass)}
                >
                  {repositoryIndex.get(issue.githubRepositoryId)?.fullName} ↗
                </a>
              </div>
            ) : initialData.github.repositories.length === 0 ? (
              <p className="mt-1 px-2 text-[12px] leading-5 text-muted">
                No repos synced.{" "}
                <Link className={interactiveLinkClass} href={workspaceSettingsPath(initialData.workspace.slug)}>
                  Settings
                </Link>
              </p>
            ) : null}

            {/* ── Parent issue ── */}
            <div className="mt-3 border-t border-border pt-3">
              <SidebarHeading title="Parent" />
              {relationshipGroups.parentIssues.length > 0 ? (
                <div className="space-y-1 px-2">
                  {relationshipGroups.parentIssues.map((parentEntry) => (
                    <div key={parentEntry.linkId} className="group flex items-center justify-between gap-2">
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          parentEntry.issue.number,
                        )}
                        className="min-w-0 truncate text-[13px] text-foreground hover:text-accent"
                      >
                        <span className="text-muted">#{parentEntry.issue.number}</span>{" "}
                        {parentEntry.issue.title}
                      </Link>
                      <button
                        type="button"
                        onClick={() => void removeLink(parentEntry.linkId)}
                        className="hidden shrink-0 text-[11px] text-muted hover:text-danger group-hover:inline"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <form
                  className="flex items-center gap-1.5 px-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addRelationship({
                      issueNumber: parentIssueNumber,
                      linkType: "sub_issue",
                      successLabel: "Parent issue linked.",
                    });
                    setParentIssueNumber("");
                  }}
                >
                  <input
                    autoComplete="off"
                    inputMode="numeric"
                    name="parentIssueNumber"
                    pattern="[0-9]*"
                    spellCheck={false}
                    value={parentIssueNumber}
                    onChange={(event) => setParentIssueNumber(event.target.value)}
                    className="sidebar-input flex-1"
                    placeholder="Issue #…"
                  />
                  <button type="submit" disabled={isSaving} className="sidebar-action-btn">
                    Set
                  </button>
                </form>
              )}
            </div>

            {/* ── Sub-issues (sidebar add) ── */}
            <div className="mt-3 border-t border-border pt-3">
              <SidebarHeading title="Sub-issues" />
              <div className="space-y-2 px-2">
                <div className="space-y-1.5">
                  <input
                    autoComplete="off"
                    name="newSubIssueTitle"
                    value={newSubIssueTitle}
                    onChange={(event) => setNewSubIssueTitle(event.target.value)}
                    className="sidebar-input w-full"
                    placeholder="New sub-issue title…"
                  />
                  {newSubIssueTitle ? (
                    <div className="flex items-center gap-1.5">
                      <select
                        name="newSubIssueEstimate"
                        value={newSubIssueEstimate}
                        onChange={(event) => setNewSubIssueEstimate(event.target.value)}
                        className="sidebar-select flex-1"
                      >
                        <option value="">No estimate</option>
                        {ISSUE_ESTIMATE_VALUES.filter((e) => e !== null).map((estimate) => (
                          <option key={estimate} value={estimate}>
                            {estimate} pt{estimate === 1 ? "" : "s"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void createSubIssue()}
                        className="sidebar-action-btn"
                      >
                        Create
                      </button>
                    </div>
                  ) : null}
                </div>
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addRelationship({
                      issueNumber: subIssueNumber,
                      linkType: "sub_issue",
                      reverse: true,
                      successLabel: "Existing sub-issue linked.",
                    });
                    setSubIssueNumber("");
                  }}
                >
                  <input
                    autoComplete="off"
                    inputMode="numeric"
                    name="subIssueNumber"
                    pattern="[0-9]*"
                    spellCheck={false}
                    value={subIssueNumber}
                    onChange={(event) => setSubIssueNumber(event.target.value)}
                    className="sidebar-input flex-1"
                    placeholder="Link existing #…"
                  />
                  <button type="submit" disabled={isSaving} className="sidebar-action-btn">
                    Link
                  </button>
                </form>
              </div>
            </div>

            {/* ── Relationships ── */}
            <div className="mt-3 border-t border-border pt-3">
              <SidebarHeading title="Relations" />
              <div className="space-y-3 px-2">
                {/* Add forms */}
                {([
                  { label: "Blocked by", state: blockedByNumber, setter: setBlockedByNumber, linkType: "blocked_by" as const, successLabel: "Blocked-by relationship added." },
                  { label: "Blocks", state: blocksNumber, setter: setBlocksNumber, linkType: "blocked_by" as const, reverse: true, successLabel: "Blocks relationship added." },
                  { label: "Duplicate", state: duplicateNumber, setter: setDuplicateNumber, linkType: "duplicate" as const, symmetric: true, successLabel: "Duplicate relationship added." },
                  { label: "Related", state: relatedNumber, setter: setRelatedNumber, linkType: "related" as const, symmetric: true, successLabel: "Related issue linked." },
                ] as const).map((rel) => (
                  <form
                    key={rel.label}
                    className="space-y-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addRelationship({
                        issueNumber: rel.state,
                        linkType: rel.linkType,
                        reverse: "reverse" in rel ? rel.reverse : undefined,
                        symmetric: "symmetric" in rel ? rel.symmetric : undefined,
                        successLabel: rel.successLabel,
                      });
                      rel.setter("");
                    }}
                  >
                    <span className="text-[11px] text-muted">{rel.label}</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        autoComplete="off"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        spellCheck={false}
                        value={rel.state}
                        onChange={(event) => rel.setter(event.target.value)}
                        className="sidebar-input flex-1"
                        placeholder="#…"
                      />
                      <button type="submit" disabled={isSaving} className="sidebar-action-btn">
                        Add
                      </button>
                    </div>
                  </form>
                ))}

                {/* Existing relationships */}
                {([
                  { entries: relationshipGroups.blockedBy, heading: "Blocked by" },
                  { entries: relationshipGroups.blocks, heading: "Blocks" },
                  { entries: relationshipGroups.duplicates, heading: "Duplicates" },
                  { entries: relationshipGroups.related, heading: "Related" },
                ] as const).map(({ entries, heading }) =>
                  entries.length > 0 ? (
                    <div key={heading} className="space-y-1">
                      <span className="text-[11px] font-medium text-muted">{heading}</span>
                      {entries.map((entry) => (
                        <div
                          key={entry.linkId}
                          className="group flex items-center gap-2"
                        >
                          <StatusIcon status={entry.issue.status} />
                          <Link
                            href={workspaceIssueDetailPath(
                              initialData.workspace.slug,
                              entry.issue.number,
                            )}
                            className="min-w-0 flex-1 truncate text-[13px] text-foreground hover:text-accent"
                          >
                            <span className="text-muted">#{entry.issue.number}</span>{" "}
                            {entry.issue.title}
                          </Link>
                          <button
                            type="button"
                            onClick={() => void removeLink(entry.linkId)}
                            className="hidden shrink-0 text-[11px] text-muted hover:text-danger group-hover:inline"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            </div>

            {/* ── GitHub PRs ── */}
            <div className="mt-3 border-t border-border pt-3">
              <SidebarHeading title="Pull Requests" />
              <div className="space-y-2 px-2">
                {pullRequests.length === 0 ? (
                  <p className="text-[12px] leading-5 text-muted">No linked PRs yet.</p>
                ) : (
                  pullRequests.map((pullRequest) => (
                    <div key={pullRequest.id} className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex items-center rounded-[4px] bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-muted">
                          {pullRequest.branchName}
                        </span>
                        {pullRequest.pullRequestState ? (
                          <span className={cn(
                            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize",
                            pullRequest.pullRequestState === "open"
                              ? "bg-success-soft text-success"
                              : pullRequest.pullRequestState === "merged"
                                ? "bg-accent-soft text-accent"
                                : "bg-danger-soft text-danger",
                          )}>
                            {pullRequest.pullRequestState}
                          </span>
                        ) : null}
                        {pullRequest.isDraft ? (
                          <span className="inline-flex items-center rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                            Draft
                          </span>
                        ) : null}
                      </div>
                      {pullRequest.pullRequestUrl ? (
                        <a
                          href={pullRequest.pullRequestUrl}
                          rel="noreferrer"
                          target="_blank"
                          className={cn("text-[12px]", interactiveLinkClass)}
                        >
                          PR #{pullRequest.pullRequestNumber ?? "?"} ↗
                        </a>
                      ) : (
                        <p className="text-[12px] text-muted">No PR yet</p>
                      )}
                      {pullRequest.repository ? (
                        <a
                          className={cn("text-[11px]", interactiveLinkClass)}
                          href={pullRequest.repository.htmlUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {pullRequest.repository.fullName}
                        </a>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
