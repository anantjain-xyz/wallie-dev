"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { TablesUpdate } from "@/lib/supabase/database.types";
import {
  createIssueWithAllocatedNumber,
  resolveIssueByNumber,
} from "@/features/issues/client";
import type { IssueDetailPageData } from "@/features/issues/detail/data";
import { buildIssueMarkdown } from "@/features/issues/detail/markdown";
import { groupIssueLinks } from "@/features/issues/detail/relationships";
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
import { workspaceIssueDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

type IssueDetailPageClientProps = {
  initialData: IssueDetailPageData;
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function Section({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur",
        className,
      )}
    >
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function messageToneClass(kind: "error" | "success") {
  return kind === "error"
    ? "border-rose-400/50 bg-rose-500/10 text-rose-900"
    : "border-emerald-400/45 bg-emerald-500/10 text-emerald-950";
}

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

  useEffect(() => {
    setIssue(initialData.issue);
    setComments(initialData.comments);
    setLinks(initialData.links);
    setLinkedIssues(initialData.linkedIssues);
  }, [
    initialData.comments,
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

  const currentMember = initialData.currentMember;
  const canManage = isWorkspaceManager(currentMember);
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
      setSuccessMessage("Issue copied as markdown.");
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
        <Section title={`Issue #${issue.number}`}>
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <IssueStatusBadge status={issue.status} />
              <IssuePriorityBadge priority={issue.priority} />
              <IssueEstimateBadge estimatePoints={issue.estimatePoints} />
              <span className="rounded-full border border-border/80 bg-background/70 px-3 py-1 font-mono text-xs text-foreground">
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
              <label className="text-xs font-semibold uppercase tracking-[0.22em] text-muted">
                Title
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  className="min-w-0 flex-1 rounded-[1.2rem] border border-border/80 bg-surface-strong/80 px-4 py-3 text-2xl font-semibold tracking-tight text-foreground outline-none transition focus:border-accent/45"
                />
                <button
                  type="submit"
                  disabled={
                    isSaving || !titleDraft.trim() || titleDraft.trim() === issue.title
                  }
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Save title
                </button>
              </div>
            </form>

            <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
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
                className="rounded-full border border-accent/40 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCopying ? "Copying..." : "Copy as markdown"}
              </button>
              <Link
                href={workspaceIssueDetailPath(
                  initialData.workspace.slug,
                  issue.number,
                )}
                className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent"
              >
                Refresh route
              </Link>
            </div>
          </div>
        </Section>

        {errorMessage ? (
          <div
            className={cn(
              "rounded-[1.4rem] border px-5 py-4 text-sm",
              messageToneClass("error"),
            )}
          >
            {errorMessage}
          </div>
        ) : null}

        {successMessage ? (
          <div
            className={cn(
              "rounded-[1.4rem] border px-5 py-4 text-sm",
              messageToneClass("success"),
            )}
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
            <textarea
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              className="min-h-56 w-full rounded-[1.2rem] border border-border/80 bg-surface-strong/80 px-4 py-4 text-sm leading-7 text-foreground outline-none transition focus:border-accent/45"
              placeholder="Issue description in markdown"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || descriptionDraft === issue.descriptionMd}
                className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save description
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
            <textarea
              value={planDraft}
              onChange={(event) => setPlanDraft(event.target.value)}
              className="min-h-44 w-full rounded-[1.2rem] border border-border/80 bg-surface-strong/80 px-4 py-4 text-sm leading-7 text-foreground outline-none transition focus:border-accent/45"
              placeholder="Execution plan in markdown"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || planDraft === (issue.planMd ?? "")}
                className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save plan
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
            <textarea
              value={designDraft}
              onChange={(event) => setDesignDraft(event.target.value)}
              className="min-h-44 w-full rounded-[1.2rem] border border-border/80 bg-surface-strong/80 px-4 py-4 text-sm leading-7 text-foreground outline-none transition focus:border-accent/45"
              placeholder="Design notes in markdown"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSaving || designDraft === (issue.designMd ?? "")}
                className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save design
              </button>
            </div>
          </form>
        </Section>

        <Section title="Comments">
          <div className="space-y-5">
            <div className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4">
              <label className="text-xs font-semibold uppercase tracking-[0.22em] text-muted">
                New comment
              </label>
              <textarea
                value={newCommentBody}
                onChange={(event) => setNewCommentBody(event.target.value)}
                className="min-h-32 w-full rounded-[1.2rem] border border-border/80 bg-background/65 px-4 py-4 text-sm leading-7 text-foreground outline-none transition focus:border-accent/45"
                placeholder="Leave a comment in markdown"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void createComment()}
                  className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Add comment
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {comments.length === 0 ? (
                <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-muted">
                  No comments yet.
                </div>
              ) : (
                comments.map((comment) => {
                  const editable =
                    comment.authorMemberId === currentMember?.id || canManage;

                  return (
                    <article
                      key={comment.id}
                      className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {comment.author?.fullName ??
                              comment.author?.username ??
                              "Unknown member"}
                          </p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted">
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
                              className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteComment(comment.id)}
                              className="rounded-full border border-rose-400/55 bg-rose-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-rose-900 transition hover:bg-rose-500/14"
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {editingCommentId === comment.id ? (
                        <div className="mt-4 space-y-3">
                          <textarea
                            value={editingCommentBody}
                            onChange={(event) =>
                              setEditingCommentBody(event.target.value)
                            }
                            className="min-h-32 w-full rounded-[1.2rem] border border-border/80 bg-background/65 px-4 py-4 text-sm leading-7 text-foreground outline-none transition focus:border-accent/45"
                          />
                          <div className="flex flex-wrap justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCommentId(null);
                                setEditingCommentBody("");
                              }}
                              className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveComment(comment.id)}
                              className="rounded-full border border-accent/45 bg-accent px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-background transition hover:bg-accent/90"
                            >
                              Save comment
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

        <Section title="Wallie timeline">
          <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-muted">
            Gate F owns run enqueueing and persisted timeline messages. This shell
            stays on the route now so the detail surface does not churn when the
            control plane lands.
          </div>
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
                className="w-full rounded-[1rem] border border-border/80 bg-surface-strong/80 px-3 py-3 text-sm font-normal text-foreground outline-none transition focus:border-accent/45"
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
                className="w-full rounded-[1rem] border border-border/80 bg-surface-strong/80 px-3 py-3 text-sm font-normal text-foreground outline-none transition focus:border-accent/45"
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
                className="w-full rounded-[1rem] border border-border/80 bg-surface-strong/80 px-3 py-3 text-sm font-normal text-foreground outline-none transition focus:border-accent/45"
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
                className="w-full rounded-[1rem] border border-border/80 bg-surface-strong/80 px-3 py-3 text-sm font-normal text-foreground outline-none transition focus:border-accent/45"
              >
                <option value="">Unassigned</option>
                {initialData.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName ?? member.username ?? "Unknown member"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Section>

        <Section title="Parent issue">
          <div className="space-y-4">
            {relationshipGroups.parentIssues.length > 0 ? (
              <div className="space-y-3">
                {relationshipGroups.parentIssues.map((parentEntry) => (
                  <div
                    key={parentEntry.linkId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
                  >
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                        Parent
                      </p>
                      <Link
                        href={workspaceIssueDetailPath(
                          initialData.workspace.slug,
                          parentEntry.issue.number,
                        )}
                        className="text-sm font-semibold text-foreground transition hover:text-accent"
                      >
                        #{parentEntry.issue.number} {parentEntry.issue.title}
                      </Link>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeLink(parentEntry.linkId)}
                      className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent"
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
                    value={parentIssueNumber}
                    onChange={(event) => setParentIssueNumber(event.target.value)}
                    className="w-full rounded-[1rem] border border-border/80 bg-surface-strong/80 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                    placeholder="42"
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Save parent
                  </button>
                </div>
              </form>
            )}
          </div>
        </Section>

        <Section title="Sub-issues">
          <div className="space-y-5">
            <div className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Create sub-issue
              </p>
              <input
                value={newSubIssueTitle}
                onChange={(event) => setNewSubIssueTitle(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Add a child issue title"
              />
              <select
                value={newSubIssueEstimate}
                onChange={(event) => setNewSubIssueEstimate(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
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
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void createSubIssue()}
                  className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Create sub-issue
                </button>
              </div>
            </div>

            <form
              className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Link existing sub-issue
              </p>
              <input
                value={subIssueNumber}
                onChange={(event) => setSubIssueNumber(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Issue number"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Link sub-issue
                </button>
              </div>
            </form>

            <div className="space-y-3">
              {relationshipGroups.subIssues.length === 0 ? (
                <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4 text-sm leading-7 text-muted">
                  No sub-issues linked yet.
                </div>
              ) : (
                relationshipGroups.subIssues.map((subIssueEntry) => (
                  <div
                    key={subIssueEntry.linkId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
                        className="text-sm font-semibold text-foreground transition hover:text-accent"
                      >
                        #{subIssueEntry.issue.number} {subIssueEntry.issue.title}
                      </Link>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeLink(subIssueEntry.linkId)}
                      className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent"
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
              className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Blocked by
              </p>
              <input
                value={blockedByNumber}
                onChange={(event) => setBlockedByNumber(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Issue number"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Add blocked-by
                </button>
              </div>
            </form>

            <form
              className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Blocks
              </p>
              <input
                value={blocksNumber}
                onChange={(event) => setBlocksNumber(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Issue number"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Add blocks
                </button>
              </div>
            </form>

            <form
              className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Duplicate of
              </p>
              <input
                value={duplicateNumber}
                onChange={(event) => setDuplicateNumber(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Issue number"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Add duplicate
                </button>
              </div>
            </form>

            <form
              className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Related
              </p>
              <input
                value={relatedNumber}
                onChange={(event) => setRelatedNumber(event.target.value)}
                className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                placeholder="Issue number"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Add related
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
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                    {heading}
                  </p>
                  {entries.length === 0 ? (
                    <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4 text-sm leading-7 text-muted">
                      No {heading.toLocaleLowerCase()} issues.
                    </div>
                  ) : (
                    entries.map((entry) => (
                      <div
                        key={entry.linkId}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4"
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
                            className="text-sm font-semibold text-foreground transition hover:text-accent"
                          >
                            #{entry.issue.number} {entry.issue.title}
                          </Link>
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeLink(entry.linkId)}
                          className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent"
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
          <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-muted">
            Gate E owns repository assignment and PR sync. This placeholder shell
            stays mounted so the detail route shape is stable while the integration
            layer lands.
          </div>
        </Section>
      </div>
    </div>
  );
}
