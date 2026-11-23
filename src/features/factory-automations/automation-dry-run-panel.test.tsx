// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AutomationDryRunPanel } from "./automation-dry-run-panel";

const automationId = "65900000-0000-4000-8000-000000000001";
const revisionId = "65900000-0000-4000-8000-000000000002";
const repositoryId = "65900000-0000-4000-8000-000000000003";
const budgetPayerMemberId = "65900000-0000-4000-8000-000000000004";
const executionPolicyRevisionId = "65900000-0000-4000-8000-000000000005";
const endpoint = "/api/automation/dry-run";
const event = { kind: "pull-request", repositoryId, action: "merged", baseBranch: "main" } as const;
const matched = {
  automationId,
  revisionId,
  matched: true,
  checks: [{ field: "baseBranch", actual: "main", expected: ["main"], passed: true }],
  budgetPayerMemberId,
  assignment: {
    status: "eligible",
    agentName: "Release reviewer",
    workflowName: null,
    executionPolicyRevisionId,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("posts the exact revision and removes the prior decision when the event changes", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(matched));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <AutomationDryRunPanel
      automationId={automationId}
      revisionId={revisionId}
      endpoint={endpoint}
      defaults={event}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Run preview" }));
  const decision = await screen.findByRole("region", { name: "Dry run results" });
  expect(within(decision).getByRole("heading", { name: "Event matches" })).toBeVisible();
  expect(within(decision).getByText("Release reviewer")).toBeVisible();
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(endpoint);
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ revisionId, event });

  const branch = screen.getByLabelText("Base branch");
  await user.clear(branch);
  await user.type(branch, "other-branch");
  expect(screen.queryByRole("region", { name: "Dry run results" })).not.toBeInTheDocument();
  fetch.mockResolvedValueOnce(
    Response.json({
      ...matched,
      matched: false,
      checks: [{ field: "baseBranch", actual: "other-branch", expected: ["main"], passed: false }],
    }),
  );
  await user.click(screen.getByRole("button", { name: "Run preview" }));
  expect(await screen.findByRole("heading", { name: "Event does not match" })).toBeVisible();
  expect(screen.getByText("Actual other-branch. Expected main.")).toBeVisible();
});

it("shows the reason a matching event cannot use the assignment", async () => {
  const message = "Approve an execution grant for this automation.";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        ...matched,
        assignment: { status: "denied", reason: "invalid_assignment", message },
      }),
    ),
  );
  render(
    <AutomationDryRunPanel
      automationId={automationId}
      revisionId={revisionId}
      endpoint={endpoint}
      defaults={event}
    />,
  );

  await userEvent.setup().click(screen.getByRole("button", { name: "Run preview" }));
  expect(await screen.findByRole("heading", { name: "Event matches" })).toBeVisible();
  expect(screen.getByText(message)).toBeVisible();
});

it("explains an invalid scheduled time before sending a preview request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <AutomationDryRunPanel
      automationId={automationId}
      revisionId={revisionId}
      endpoint={endpoint}
      defaults={{ kind: "schedule", scheduledFor: "2030-01-07T09:00:00" }}
    />,
  );

  await userEvent.setup().click(screen.getByRole("button", { name: "Run preview" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter an ISO timestamp with seconds and a timezone",
  );
  expect(fetch).not.toHaveBeenCalled();
});
