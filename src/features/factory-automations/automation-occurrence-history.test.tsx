// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { automationHistorySchema } from "@/lib/factory-automations/operator-contracts";
import { workspaceAutomationPreviewPath } from "@/lib/routes";

import { AutomationOccurrenceHistory } from "./automation-occurrence-history";

afterEach(cleanup);

it("links receipts to their exact revision IDs rather than the rule's current revision", () => {
  const first = "66410000-0000-4000-8000-000000000201";
  const second = "66410000-0000-4000-8000-000000000202";
  const factory = "66410000-0000-4000-8000-000000000203";
  const automation = "66410000-0000-4000-8000-000000000204";
  const recordedAt = "2026-11-23T12:34:56.123456Z";
  const history = automationHistorySchema.parse({
    occurrences: [first, second].map((revisionId, index) => ({
      id: `66410000-0000-4000-8000-00000000020${index + 5}`,
      revisionId,
      revisionNumber: index + 1,
      triggerKind: "schedule",
      attemptCount: 1,
      recordedAt,
      status: "admitted",
      reason: null,
      settledAt: recordedAt,
      nextAttemptAt: null,
      sessionNumber: index === 0 ? 90 : null,
    })),
    nextCursor: null,
  });

  render(
    <AutomationOccurrenceHistory
      history={history}
      revisionHref={(revision) =>
        workspaceAutomationPreviewPath("example", { factory, automation, revision })
      }
      workspaceSlug="example"
    />,
  );

  expect(screen.getByRole("link", { name: "Revision 1" })).toHaveAttribute(
    "href",
    `/w/example/settings/automations?factory=${factory}&automation=${automation}&revision=${first}`,
  );
  expect(screen.getByRole("link", { name: "Revision 2" })).toHaveAttribute(
    "href",
    `/w/example/settings/automations?factory=${factory}&automation=${automation}&revision=${second}`,
  );
  expect(screen.getByRole("link", { name: "Session #90" })).toBeVisible();
});
