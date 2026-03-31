import { describe, expect, it } from "vitest";

import { groupIssueLinks } from "@/features/issues/detail/relationships";
import type { IssueSummary } from "@/features/issues/types";

function makeIssue(id: string, number: number, title: string): IssueSummary {
  return {
    assignee: null,
    assigneeMemberId: null,
    createdAt: "2026-03-30T00:00:00.000Z",
    creator: null,
    creatorMemberId: null,
    descriptionMd: "",
    estimatePoints: null,
    githubRepositoryId: null,
    id,
    number,
    priority: "none",
    status: "backlog",
    title,
    updatedAt: "2026-03-30T00:00:00.000Z",
    workspaceId: "workspace-1",
  };
}

describe("groupIssueLinks", () => {
  it("maps directional blocked and sub-issue links into UI groups", () => {
    const issueMap = new Map([
      ["issue-2", makeIssue("issue-2", 2, "Parent")],
      ["issue-3", makeIssue("issue-3", 3, "Child")],
      ["issue-4", makeIssue("issue-4", 4, "Dependency")],
      ["issue-5", makeIssue("issue-5", 5, "Blocked target")],
    ]);

    const groups = groupIssueLinks(
      "issue-1",
      [
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-parent",
          link_type: "sub_issue",
          source_issue_id: "issue-1",
          target_issue_id: "issue-2",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-child",
          link_type: "sub_issue",
          source_issue_id: "issue-3",
          target_issue_id: "issue-1",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-blocked-by",
          link_type: "blocked_by",
          source_issue_id: "issue-1",
          target_issue_id: "issue-4",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-blocks",
          link_type: "blocked_by",
          source_issue_id: "issue-5",
          target_issue_id: "issue-1",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
      ],
      issueMap,
    );

    expect(groups.parentIssues.map((entry) => entry.issue.number)).toEqual([2]);
    expect(groups.subIssues.map((entry) => entry.issue.number)).toEqual([3]);
    expect(groups.blockedBy.map((entry) => entry.issue.number)).toEqual([4]);
    expect(groups.blocks.map((entry) => entry.issue.number)).toEqual([5]);
  });

  it("deduplicates symmetric duplicate and related links by issue", () => {
    const issueMap = new Map([["issue-2", makeIssue("issue-2", 2, "Peer")]]);

    const groups = groupIssueLinks(
      "issue-1",
      [
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-1",
          link_type: "duplicate",
          source_issue_id: "issue-1",
          target_issue_id: "issue-2",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-2",
          link_type: "duplicate",
          source_issue_id: "issue-2",
          target_issue_id: "issue-1",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
        {
          created_at: "2026-03-30T00:00:00.000Z",
          id: "link-3",
          link_type: "related",
          source_issue_id: "issue-1",
          target_issue_id: "issue-2",
          updated_at: "2026-03-30T00:00:00.000Z",
          workspace_id: "workspace-1",
        },
      ],
      issueMap,
    );

    expect(groups.duplicates).toHaveLength(1);
    expect(groups.related).toHaveLength(1);
    expect(groups.duplicates[0]?.issue.number).toBe(2);
    expect(groups.related[0]?.issue.number).toBe(2);
  });
});
