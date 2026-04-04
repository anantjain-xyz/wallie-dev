import type { Tables } from "@/lib/supabase/database.types";
import type { IssueLinkType, IssueSummary } from "@/features/issues/types";

export type IssueRelationshipEntry = {
  direction: "incoming" | "outgoing";
  issue: IssueSummary;
  linkId: string;
  linkType: IssueLinkType;
};

export type IssueRelationshipGroups = {
  blockedBy: IssueRelationshipEntry[];
  blocks: IssueRelationshipEntry[];
  duplicates: IssueRelationshipEntry[];
  parentIssues: IssueRelationshipEntry[];
  related: IssueRelationshipEntry[];
  subIssues: IssueRelationshipEntry[];
};

function pushUniqueRelationship(target: IssueRelationshipEntry[], entry: IssueRelationshipEntry) {
  const duplicate = target.find(
    (candidate) => candidate.issue.id === entry.issue.id && candidate.linkType === entry.linkType,
  );

  if (!duplicate) {
    target.push(entry);
  }
}

export function groupIssueLinks(
  issueId: string,
  links: readonly Tables<"issue_links">[],
  linkedIssues: ReadonlyMap<string, IssueSummary>,
): IssueRelationshipGroups {
  const groups: IssueRelationshipGroups = {
    blockedBy: [],
    blocks: [],
    duplicates: [],
    parentIssues: [],
    related: [],
    subIssues: [],
  };

  for (const link of links) {
    const outgoing = link.source_issue_id === issueId;
    const linkedIssueId = outgoing ? link.target_issue_id : link.source_issue_id;
    const linkedIssue = linkedIssues.get(linkedIssueId);

    if (!linkedIssue) {
      continue;
    }

    const entry: IssueRelationshipEntry = {
      direction: outgoing ? "outgoing" : "incoming",
      issue: linkedIssue,
      linkId: link.id,
      linkType: link.link_type,
    };

    switch (link.link_type) {
      case "blocked_by":
        if (outgoing) {
          groups.blockedBy.push(entry);
        } else {
          groups.blocks.push(entry);
        }
        break;
      case "sub_issue":
        if (outgoing) {
          groups.parentIssues.push(entry);
        } else {
          groups.subIssues.push(entry);
        }
        break;
      case "duplicate":
        pushUniqueRelationship(groups.duplicates, entry);
        break;
      case "related":
        pushUniqueRelationship(groups.related, entry);
        break;
    }
  }

  groups.subIssues.sort((left, right) => left.issue.number - right.issue.number);
  groups.blockedBy.sort((left, right) => left.issue.number - right.issue.number);
  groups.blocks.sort((left, right) => left.issue.number - right.issue.number);
  groups.duplicates.sort((left, right) => left.issue.number - right.issue.number);
  groups.related.sort((left, right) => left.issue.number - right.issue.number);
  groups.parentIssues.sort((left, right) => left.issue.number - right.issue.number);

  return groups;
}
