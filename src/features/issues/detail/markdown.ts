import { workspaceIssueDetailPath } from "@/lib/routes";
import {
  formatIssueEstimate,
  formatIssuePriority,
  formatIssueStatus,
  getIssueMemberDisplayName,
  type IssueComment,
  type IssueDetail,
} from "@/features/issues/types";

export function buildIssueMarkdown(
  workspaceSlug: string,
  issue: IssueDetail,
  comments: readonly IssueComment[],
) {
  const sections = [
    `# ${issue.title}`,
    "",
    issue.descriptionMd || "_No description_",
    "",
    "## Metadata",
    "",
    `- Issue: #${issue.number}`,
    `- Route: ${workspaceIssueDetailPath(workspaceSlug, issue.number)}`,
    `- Status: ${formatIssueStatus(issue.status)}`,
    `- Priority: ${formatIssuePriority(issue.priority)}`,
    `- Estimate: ${formatIssueEstimate(issue.estimatePoints)}`,
    `- Assignee: ${getIssueMemberDisplayName(issue.assignee)}`,
  ];

  if (issue.planMd?.trim()) {
    sections.push("", "## Plan", "", issue.planMd.trim());
  }

  if (issue.designMd?.trim()) {
    sections.push("", "## Design", "", issue.designMd.trim());
  }

  if (comments.length > 0) {
    sections.push("", "## Comments", "");

    for (const comment of comments) {
      sections.push(
        `- ${getIssueMemberDisplayName(comment.author)} (${new Date(
          comment.createdAt,
        ).toLocaleString()}):`,
        "",
        `  ${comment.bodyMd.replaceAll("\n", "\n  ")}`,
        "",
      );
    }
  }

  return sections.join("\n").trim();
}
