import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { FailureCohortSummary } from "@/lib/factory-failures/cohort-contracts";

import {
  FailureGroupCounts,
  FailureGroupLimits,
  FailureGroupStatus,
  failureGroupTitle,
} from "./failure-group-summary";

const group = {
  id: "63400000-0000-4000-8000-000000000001",
  agent_id: "63400000-0000-4000-8000-000000000002",
  task_class_slug: "build",
  symptom_kind: "validation",
  symptom_label: "Build checks",
  qualification: "inconclusive",
  qualification_reasons: ["insufficient_support", "missing_evidence"],
  failure_count: 3,
  support_count: 1,
  minimum_support: 3,
  version_count: 2,
  review: { revision: 1, disposition: "dismissed", label: "Flaky build step", can_review: false },
  parent_cohort_id: null,
  partition: null,
  split_cohort_ids: [],
} satisfies FailureCohortSummary;

it("renders a reviewed label without hiding the independent evidence limits", () => {
  const html = renderToStaticMarkup(
    <section>
      <h2>{failureGroupTitle(group)}</h2>
      <FailureGroupStatus cohort={group} />
      <FailureGroupLimits cohort={group} />
      <FailureGroupCounts cohort={group} />
    </section>,
  );
  expect(html).toContain("Flaky build step");
  expect(html).toContain("Dismissed");
  expect(html).toContain("Inconclusive");
  expect(html).toContain("Insufficient support");
  expect(html).toContain("Missing evidence");
  expect(html).toContain("1 of 3 needed");
});
