"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";

import type { Tables, TablesUpdate } from "@/lib/supabase/database.types";
import {
  createIssueWithAllocatedNumber,
  resolveIssueByNumber,
} from "@/features/issues/client";
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
  IssueMemberBadge,
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

function mapPullRequestRow(
  row: Tables<"github_issue_branches">,
  repositoryIndex: ReadonlyMap<
    string,
    IssueDetailPageData["github"]["repositories"][number]
  >,
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
      ? repositoryIndex.get(row.github_repository_id) ?? null
      : null,
    updatedAt: row.updated_at,
  };
}

function Section({
  children,
  className,
  headingAs = "h2",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  headingAs?: "h1" | "h2" | "h3";
  title: string;
}) {
  const HeadingTag = headingAs;

  return (
    <section
      className={cn(
        "ui-panel p-5",
        className,
      )}
    >
      <HeadingTag className="text-base font-semibold tracking-tight text-balance text-foreground">
        {title}
      </HeadingTag>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function messageToneClass(kind: "error" | "success") {
  return kind === "error"
    ? "border-danger/20 bg-danger-soft text-danger"
    : "border-success/20 bg-success-soft text-success";
}

const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

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
      ...linkedIssues.flatMap((linkedIssue) => [
        linkedIssue.assignee,
        linkedIssue.creator,
      ]),
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
        (link.source_issue_id === sourceIssueId &&
          link.target_issue_id === targetIssueId) ||
        (link.source_issue_id === targetIssueId &&
          link.target_issue_id === sourceIssueId)
      );
    }

    return (
      link.source_issue_id === sourceIssueId &&
      link.target_issue_id === targetIssueId
    );
  });
}

export function IssueDetailPageClient({
  initialData,
}: IssueDetailPageClientProps) {
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [issue, setIssue] = useState(initialData.issue);
  const [comments, setComments] = useState(initialData.comments);
  const [links, setLinks] = useState(initialData.links);
  const [linkedIssues, setLinkedIssues] = useState(initialData.linkedIssues);
  const [pullRequests, setPullRequests] = useState(initialData.github.pullRequests);
  const [titleDraft, setTitleDraft] = useState(initialData.issue.title);
  const [descriptionDraft, setDescriptionDraft] = useState(
    initialData.issue.descriptionMd,
  );
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
  const handlePullRequestRealtimeUpdate = useEffectEvent(
    (row: Tables<"github_issue_branches">) => {
      const nextPullRequest = mapPullRequestRow(row, repositoryIndex);

      setPullRequests((currentPullRequests) => {
        const nextPullRequests = currentPullRequests.filter(
          (pullRequest) => pullRequest.id !== nextPullRequest.id,
        );

        nextPullRequests.unshift(nextPullRequest);
        nextPullRequests.sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        );

        return nextPullRequests;
      });
    },
  );

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
              currentPullRequests.filter(
                (pullRequest) => pullRequest.id !== payload.old.id,
              ),
            );
            return;
          }

          handlePullRequestRealtimeUpdate(
            payload.new as Tables<"github_issue_branches">,
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(issueChannel);
      void supabase.removeChannel(pullRequestChannel);
    };
  }, [issue.id, supabase]);

  async function saveIssuePatch(
    patch: TablesUpdate<"issues">,
  ) {
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
      setErrorMessage(
        error instanceof Error ? error.message : "Issue update failed.",
      );
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

      setComments((currentComments) => [
        ...currentComments,
        mapIssueCommentRow(data, memberIndex),
      ]);
      setNewCommentBody("");
      setSuccessMessage("Comment added.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Comment creation failed.",
      );
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
        currentComments.map((comment) =>
          comment.id === nextComment.id ? nextComment : comment,
        ),
      );
      setEditingCommentId(null);
      setEditingCommentBody("");
      setSuccessMessage("Comment updated.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Comment update failed.",
      );
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
      const { error } = await supabase
        .from("issue_comments")
        .delete()
        .eq("id", commentId);

      if (error) {
        throw error;
      }

      setComments((currentComments) =>
        currentComments.filter((comment) => comment.id !== commentId),
      );
      setSuccessMessage("Comment deleted.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Comment deletion failed.",
      );
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
        relationExists(
          links,
          sourceIssueId,
          targetIssueId,
          options.linkType,
          options.symmetric,
        )
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
      setErrorMessage(
        error instanceof Error ? error.message : "Relationship update failed.",
      );
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
      setErrorMessage(
        error instanceof Error ? error.message : "Sub-issue creation failed.",
      );
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
      const { error } = await supabase
        .from("issue_links")
        .delete()
        .eq("id", linkId);

      if (error) {
        throw error;
      }

      setLinks((currentLinks) =>
        currentLinks.filter((link) => link.id !== linkId),
      );
      setSuccessMessage("Relationship removed.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Relationship removal failed.",
      );
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
      setErrorMessage(
        error instanceof Error ? error.message : "Clipboard copy failed.",
      );
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1.18fr_0.82fr]">
      <div className="grid gap-6">
        <Section title={`Issue #${issue.number}`} headingAs="h1">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <IssueStatusBadge status={issue.status} />
              <IssuePriorityBadge priority={issue.priority} />
              <IssueEstimateBadge estimatePoints={issue.estimatePoints} />
              <span className="ui-pill font-mono">
                /w/{initialData.workspace.slug}/issues/{issue.number}
              </span>
            </div>

            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (titleDraft.trim() && titleDraft.trim() !== issue.title) {
                  void saveIssuePatch({
                    title: titleDraft.trim(),
                  });
                }
              }}
            >
              <label className="ui-label" htmlFor="issue-title">
                Title
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  id="issue-title"
                  autoComplete="off"
                  name="title"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  className="ui-input min-w-0 flex-1 px-4 py-3 text-2xl font-semibold tracking-tight"
                />
                <button
                  type="submit"
                  disabled={
                    isSaving || !titleDraft.trim() || titleDraft.trim() === issue.title
                  }
                  className="ui-button"
                >
                  Save Title
                </button>
              </div>
            </form>

            <div className="flex flex-wrap items-center gap-3 text-sm tabular-nums text-muted">
              <span>
                Created {dateTimeFormatter.format(new Date(issue.createdAt))}
              </span>
              <span>
                Updated {dateTimeFormatter.format(new Date(issue.updatedAt))}
              </span>
              <IssueMemberBadge fallback="No creator" member={issue.creator} />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void copyAsMarkdown()}
                disabled={isCopying}
                className="ui-button-primary"
              >
                {isCopying ? "Copying…" : "Copy as Markdown"}
              </button>
              <Link
                href={workspaceIssueDetailPath(
                  initialData.workspace.slug,
                  issue.number,
                )}
                className="ui-button"
              >
                Refresh Route
              </Link>
            </div>
          </div>
        </Section>

        {errorMessage ? (
          <div
            aria-live="polite"
            className={cn(
              "rounded-[12px] border px-4 py-3 text-sm",
              messageToneClass("error"),
            )}
            role="status"
          >
            {errorMessage}
          </div>
        ) : null}

        {successMessage ? (
          <div
            aria-live="polite"
            className={cn(
              "rounded-[12px] border px-4 py-3 text-sm",
              messageToneClass("success"),
            )}
            role="status"
          >
            {successMessage}
          </div>
        ) : null}

        <Section title="Description">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (descriptionDraft !== issue.descriptionMd) {
                void saveIssuePatch({
                  description_md: descriptionDraft,
                });
              }
            }}
          >
            <label className="ui-label" htmlFor="issue-description">
              Issue Description
            </label>
            <textarea
              id="issue-description"
              aria-label="Issue Description"
              autoComplete="off"
              name="description"
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              className="ui-textarea min-h-56 leading-7"
              placeholder="Describe the Issue in Markdown…"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || descriptionDraft === issue.descriptionMd}
                className="ui-button"
              >
                Save Description
              </button>
            </div>
          </form>
        </Section>

        <Section title="Plan">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (planDraft !== (issue.planMd ?? "")) {
                void saveIssuePatch({
                  plan_md: planDraft.trim() ? planDraft : null,
                });
              }
            }}
          >
            <label className="ui-label" htmlFor="issue-plan">
              Execution Plan
            </label>
            <textarea
              id="issue-plan"
              aria-label="Execution Plan"
              autoComplete="off"
              name="plan"
              value={planDraft}
              onChange={(event) => setPlanDraft(event.target.value)}
              className="ui-textarea min-h-44 leading-7"
              placeholder="Outline the Execution Plan in Markdown…"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || planDraft === (issue.planMd ?? "")}
                className="ui-button"
              >
                Save Plan
              </button>
            </div>
          </form>
        </Section>

        <Section title="Design">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (designDraft !== (issue.designMd ?? "")) {
                void saveIssuePatch({
                  design_md: designDraft.trim() ? designDraft : null,
                });
              }
            }}
          >
            <label className="ui-label" htmlFor="issue-design">
              Design Notes
            </label>
            <textarea
              id="issue-design"
              aria-label="Design Notes"
              autoComplete="off"
              name="design"
              value={designDraft}
              onChange={(event) => setDesignDraft(event.target.value)}
              className="ui-textarea min-h-44 leading-7"
              placeholder="Capture Design Notes in Markdown…"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || designDraft === (issue.designMd ?? "")}
                className="ui-button"
              >
                Save Design
              </button>
            </div>
          </form>
        </Section>

        <Section title="Comments">
          <div className="space-y-5">
            <div className="ui-subpanel space-y-3 p-4">
              <label className="ui-label" htmlFor="new-comment">
                New comment
              </label>
              <textarea
                id="new-comment"
                autoComplete="off"
                name="newComment"
                value={newCommentBody}
                onChange={(event) => setNewCommentBody(event.target.value)}
                className="ui-textarea min-h-32 leading-7"
                placeholder="Leave a Comment in Markdown…"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void createComment()}
                  className="ui-button-primary"
                >
                  Add Comment
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {comments.length === 0 ? (
                <div className="ui-subpanel p-5 text-sm leading-7 text-muted">
                  No comments yet.
                </div>
              ) : (
                comments.map((comment) => {
                  const editable =
                    comment.authorMemberId === currentMember?.id || canManage;

                  return (
                    <article
                      key={comment.id}
                      className="ui-subpanel p-5"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {comment.author?.fullName ??
                              comment.author?.username ??
                              "Unknown member"}
                          </p>
                          <p className="mt-1 text-[11px] text-muted">
                            {dateTimeFormatter.format(
                              new Date(comment.createdAt),
                            )}
                            {comment.updatedAt !== comment.createdAt
                              ? " · edited"
                              : ""}
                          </p>
                        </div>

                        {editable ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCommentId(comment.id);
                                setEditingCommentBody(comment.bodyMd);
                              }}
                              className="ui-button"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteComment(comment.id)}
                              className="ui-button-danger"
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {editingCommentId === comment.id ? (
                        <div className="mt-4 space-y-3">
                          <textarea
                            aria-label="Edit Comment"
                            autoComplete="off"
                            name="editingComment"
                            value={editingCommentBody}
                            onChange={(event) =>
                              setEditingCommentBody(event.target.value)
                            }
                            className="ui-textarea min-h-32 leading-7"
                          />
                          <div className="flex flex-wrap justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCommentId(null);
                                setEditingCommentBody("");
                              }}
                              className="ui-button"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveComment(comment.id)}
                              className="ui-button-primary"
                            >
                              Save Comment
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 whitespace-pre-wrap text-sm leading-7 text-foreground/90">
                          {comment.bodyMd}
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </Section>

        <Section title="Wallie Timeline">
          <IssueWalliePanel
            initialData={initialData.wallie}
            issue={issue}
            memberIndex={memberIndex}
            repositories={initialData.github.repositories}
            supabase={supabase}
            workspaceSlug={initialData.workspace.slug}
          />
        </Section>
      </div>

      <div className="grid gap-6">
        <Section title="Metadata">
          <div className="grid gap-4">
            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Status</span>
              <select
                value={issue.status}
                onChange={(event) =>
                  void saveIssuePatch({
                    status: event.target.value as IssueStatus,
                  })
                }
                className="ui-select"
              >
                {ISSUE_STATUS_VALUES.map((status) => (
                  <option key={status} value={status}>
                    {formatIssueStatus(status)}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Priority</span>
              <select
                value={issue.priority}
                onChange={(event) =>
                  void saveIssuePatch({
                    priority: event.target.value as IssueDetail["priority"],
                  })
                }
                className="ui-select"
              >
                {ISSUE_PRIORITY_VALUES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Estimate</span>
              <select
                value={issue.estimatePoints === null ? "null" : String(issue.estimatePoints)}
                onChange={(event) =>
                  void saveIssuePatch({
                    estimate_points:
                      event.target.value === "null"
                        ? null
                        : Number(event.target.value),
                  })
                }
                className="ui-select"
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
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Assignee</span>
              <select
                value={issue.assigneeMemberId ?? ""}
                onChange={(event) =>
                  void saveIssuePatch({
                    assignee_member_id: event.target.value || null,
                  })
                }
                className="ui-select"
              >
                <option value="">Unassigned</option>
                {initialData.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName ?? member.username ?? "Unknown member"}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-sm font-semibold text-foreground">
              <span>Repository</span>
              <select
                value={issue.githubRepositoryId ?? ""}
                onChange={(event) =>
                  void saveIssuePatch({
                    github_repository_id: event.target.value || null,
                  })
                }
                className="ui-select"
              >
                <option value="">No linked repository</option>
                {initialData.github.repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.fullName}
                  </option>
                ))}
              </select>
            </label>

            {issue.githubRepositoryId ? (
              repositoryIndex.get(issue.githubRepositoryId) ? (
                <a
                  href={repositoryIndex.get(issue.githubRepositoryId)?.htmlUrl}
                  rel="noreferrer"
                  target="_blank"
                  className={cn("text-sm", interactiveLinkClass)}
                >
                  {repositoryIndex.get(issue.githubRepositoryId)?.fullName}
                </a>
              ) : null
            ) : initialData.github.repositories.length === 0 ? (
              <p className="text-sm leading-6 text-muted">
                No GitHub repositories are synced yet. Install the workspace GitHub App from{" "}
                <Link
                  className={interactiveLinkClass}
                  href={workspaceSettingsPath(initialData.workspace.slug)}
                >
                  Settings
                </Link>
                .
              </p>
            ) : null}
          </div>
        </Section>

        <Section title="Parent issue">
          <div className="space-y-4">
            {relationshipGroups.parentIssues.length > 0 ? (
              <div className="space-y-3">
                {relationshipGroups.parentIssues.map((parentEntry) => (
                  <div
                    key={parentEntry.linkId}
                    className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div className="space-y-2">
                      <p className="ui-label">
                        Parent
                      </p>
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          parentEntry.issue.number,
                        )}
                        className={cn("text-sm", interactiveLinkClass)}
                      >
                        #{parentEntry.issue.number} {parentEntry.issue.title}
                      </Link>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeLink(parentEntry.linkId)}
                      className="ui-button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {relationshipGroups.parentIssues.length > 1 ? (
                  <p className="text-sm leading-6 text-muted">
                    Multiple parent rows exist in data. Gate D surfaces all of them but
                    only allows adding one parent at a time going forward.
                  </p>
                ) : null}
              </div>
            ) : (
              <form
                className="space-y-3"
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
                <label className="space-y-2 text-sm font-semibold text-foreground">
                  <span>Set parent issue number</span>
                  <input
                    autoComplete="off"
                    inputMode="numeric"
                    name="parentIssueNumber"
                    pattern="[0-9]*"
                    spellCheck={false}
                    value={parentIssueNumber}
                    onChange={(event) => setParentIssueNumber(event.target.value)}
                    className="ui-input"
                    placeholder="42…"
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="ui-button"
                  >
                    Set Parent Issue
                  </button>
                </div>
              </form>
            )}
          </div>
        </Section>

        <Section title="Sub-issues">
          <div className="space-y-5">
            <div className="ui-subpanel space-y-3 p-4">
              <p className="ui-label">
                Create sub-issue
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Sub-Issue Title</span>
                <input
                  autoComplete="off"
                  name="newSubIssueTitle"
                  value={newSubIssueTitle}
                  onChange={(event) => setNewSubIssueTitle(event.target.value)}
                  className="ui-input"
                  placeholder="Add a Child Issue Title…"
                />
              </label>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Estimate</span>
                <select
                  name="newSubIssueEstimate"
                  value={newSubIssueEstimate}
                  onChange={(event) => setNewSubIssueEstimate(event.target.value)}
                  className="ui-select"
                >
                  <option value="">No estimate</option>
                  {ISSUE_ESTIMATE_VALUES.filter(
                    (estimate) => estimate !== null,
                  ).map((estimate) => (
                    <option key={estimate} value={estimate}>
                      {estimate} point{estimate === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void createSubIssue()}
                  className="ui-button-primary"
                >
                  Create Sub-Issue
                </button>
              </div>
            </div>

            <form
              className="ui-subpanel space-y-3 p-4"
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
              <p className="ui-label">
                Link existing sub-issue
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Issue Number</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  name="subIssueNumber"
                  pattern="[0-9]*"
                  spellCheck={false}
                  value={subIssueNumber}
                  onChange={(event) => setSubIssueNumber(event.target.value)}
                  className="ui-input"
                  placeholder="Issue #42…"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="ui-button"
                >
                  Link Sub-Issue
                </button>
              </div>
            </form>

            <div className="space-y-3">
              {relationshipGroups.subIssues.length === 0 ? (
                <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
                  No sub-issues linked yet.
                </div>
              ) : (
                relationshipGroups.subIssues.map((subIssueEntry) => (
                  <div
                    key={subIssueEntry.linkId}
                    className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <IssueStatusBadge status={subIssueEntry.issue.status} />
                        <IssuePriorityBadge priority={subIssueEntry.issue.priority} />
                      </div>
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          subIssueEntry.issue.number,
                        )}
                        className={cn("text-sm", interactiveLinkClass)}
                      >
                        #{subIssueEntry.issue.number} {subIssueEntry.issue.title}
                      </Link>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeLink(subIssueEntry.linkId)}
                      className="ui-button"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </Section>

        <Section title="Relationships">
          <div className="space-y-5">
            <form
              className="ui-subpanel space-y-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void addRelationship({
                  issueNumber: blockedByNumber,
                  linkType: "blocked_by",
                  successLabel: "Blocked-by relationship added.",
                });
                setBlockedByNumber("");
              }}
            >
              <p className="ui-label">
                Blocked by
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Issue Number</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  name="blockedByNumber"
                  pattern="[0-9]*"
                  spellCheck={false}
                  value={blockedByNumber}
                  onChange={(event) => setBlockedByNumber(event.target.value)}
                  className="ui-input"
                  placeholder="Issue #42…"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="ui-button"
                >
                  Add Blocked-By Link
                </button>
              </div>
            </form>

            <form
              className="ui-subpanel space-y-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void addRelationship({
                  issueNumber: blocksNumber,
                  linkType: "blocked_by",
                  reverse: true,
                  successLabel: "Blocks relationship added.",
                });
                setBlocksNumber("");
              }}
            >
              <p className="ui-label">
                Blocks
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Issue Number</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  name="blocksNumber"
                  pattern="[0-9]*"
                  spellCheck={false}
                  value={blocksNumber}
                  onChange={(event) => setBlocksNumber(event.target.value)}
                  className="ui-input"
                  placeholder="Issue #42…"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="ui-button"
                >
                  Add Blocks Link
                </button>
              </div>
            </form>

            <form
              className="ui-subpanel space-y-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void addRelationship({
                  issueNumber: duplicateNumber,
                  linkType: "duplicate",
                  symmetric: true,
                  successLabel: "Duplicate relationship added.",
                });
                setDuplicateNumber("");
              }}
            >
              <p className="ui-label">
                Duplicate of
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Issue Number</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  name="duplicateNumber"
                  pattern="[0-9]*"
                  spellCheck={false}
                  value={duplicateNumber}
                  onChange={(event) => setDuplicateNumber(event.target.value)}
                  className="ui-input"
                  placeholder="Issue #42…"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="ui-button"
                >
                  Add Duplicate Link
                </button>
              </div>
            </form>

            <form
              className="ui-subpanel space-y-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void addRelationship({
                  issueNumber: relatedNumber,
                  linkType: "related",
                  symmetric: true,
                  successLabel: "Related issue linked.",
                });
                setRelatedNumber("");
              }}
            >
              <p className="ui-label">
                Related
              </p>
              <label className="space-y-2 text-sm font-semibold text-foreground">
                <span>Issue Number</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  name="relatedNumber"
                  pattern="[0-9]*"
                  spellCheck={false}
                  value={relatedNumber}
                  onChange={(event) => setRelatedNumber(event.target.value)}
                  className="ui-input"
                  placeholder="Issue #42…"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="ui-button"
                >
                  Add Related Link
                </button>
              </div>
            </form>

            <div className="space-y-4">
              {[
                {
                  entries: relationshipGroups.blockedBy,
                  heading: "Blocked by",
                },
                {
                  entries: relationshipGroups.blocks,
                  heading: "Blocks",
                },
                {
                  entries: relationshipGroups.duplicates,
                  heading: "Duplicates",
                },
                {
                  entries: relationshipGroups.related,
                  heading: "Related",
                },
              ].map(({ entries, heading }) => (
                <div key={heading} className="space-y-3">
                  <p className="ui-label">
                    {heading}
                  </p>
                  {entries.length === 0 ? (
                    <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
                      No {heading.toLocaleLowerCase()} issues.
                    </div>
                  ) : (
                    entries.map((entry) => (
                      <div
                        key={entry.linkId}
                        className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                      >
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <IssueStatusBadge status={entry.issue.status} />
                            <IssuePriorityBadge priority={entry.issue.priority} />
                          </div>
                          <Link
                            href={workspaceIssueDetailPath(
                              initialData.workspace.slug,
                              entry.issue.number,
                            )}
                            className={cn("text-sm", interactiveLinkClass)}
                          >
                            #{entry.issue.number} {entry.issue.title}
                          </Link>
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeLink(entry.linkId)}
                          className="ui-button"
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section title="GitHub PRs">
          <div className="space-y-4">
            {pullRequests.length === 0 ? (
              <div className="ui-subpanel p-5 text-sm leading-7 text-muted">
                No PR metadata is linked to this issue yet. Once a tracked branch opens a PR, the webhook sync will surface it here.
              </div>
            ) : (
              pullRequests.map((pullRequest) => (
                <article
                  key={pullRequest.id}
                  className="ui-subpanel p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="ui-pill font-mono">
                          {pullRequest.branchName}
                        </span>
                        {pullRequest.pullRequestState ? (
                          <span className="ui-pill">
                            {pullRequest.pullRequestState}
                          </span>
                        ) : null}
                        {pullRequest.isDraft ? (
                          <span className="ui-pill border-warning/20 bg-warning-soft text-warning">
                            Draft
                          </span>
                        ) : null}
                      </div>

                      {pullRequest.pullRequestUrl ? (
                        <a
                          href={pullRequest.pullRequestUrl}
                          rel="noreferrer"
                          target="_blank"
                          className={cn("text-sm", interactiveLinkClass)}
                        >
                          PR #{pullRequest.pullRequestNumber ?? "?"}
                        </a>
                      ) : (
                        <p className="text-sm font-semibold text-foreground">
                          Branch tracked without a PR URL yet
                        </p>
                      )}

                      <p className="text-sm leading-6 text-muted">
                        {pullRequest.repository ? (
                          <>
                            Repo{" "}
                            <a
                              className={interactiveLinkClass}
                              href={pullRequest.repository.htmlUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {pullRequest.repository.fullName}
                            </a>
                          </>
                        ) : (
                          "Repository unavailable"
                        )}
                      </p>
                    </div>

                    <div className="text-right text-xs uppercase tracking-[0.16em] tabular-nums text-muted">
                      <p>
                        Created {dateTimeFormatter.format(new Date(pullRequest.createdAt))}
                      </p>
                      <p className="mt-2">
                        Updated {dateTimeFormatter.format(new Date(pullRequest.updatedAt))}
                      </p>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
