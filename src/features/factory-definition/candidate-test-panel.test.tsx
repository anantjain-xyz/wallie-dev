// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { CandidateTestPanel } from "@/features/factory-definition/candidate-test-panel";
import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";

const target = {
  kind: "draft",
  id: "bc350948-d9f1-45d6-a175-a22769baf461",
  digest: "b".repeat(64),
} satisfies ComponentProps<typeof CandidateTestPanel>["target"];
const latestId = "98f67536-6ede-456b-807e-7dafebf8f1df";
const priorId = "b10e5093-05c0-4696-921f-1a31b15dcfb7";
const promptDigest = "c".repeat(64);
const failed: CandidateSmokeTest = {
  id: latestId,
  target: { kind: target.kind, id: target.id },
  definitionDigest: target.digest,
  baseActivationNumber: 2,
  policyVersion: 1,
  status: "failed",
  createdAt: "2026-11-16T22:20:00Z",
  finishedAt: "2026-11-16T22:21:00Z",
  evidence: null,
  error: "The test exceeded its time limit.",
};
const passed: CandidateSmokeTest = {
  ...failed,
  id: priorId,
  status: "passed",
  baseActivationNumber: 1,
  createdAt: "2026-11-15T22:20:00Z",
  finishedAt: "2026-11-15T22:21:00Z",
  error: null,
};

const baseProps = {
  target,
  purpose: "publish",
  activationNumber: 2,
  tests: [],
  eligibility: { eligible: false, reason: "Run a test for this draft.", activationNumber: 2 },
  loading: false,
  error: null,
  actionError: null,
  pending: null,
  allowStart: true,
  onStart: () => undefined,
  onCancel: () => undefined,
  onRefresh: () => undefined,
  selectedTestId: null,
  selectedTest: null,
  evidenceLoading: false,
  evidenceError: null,
  onSelectTest: () => undefined,
  evidenceHref: (id: string) =>
    `/w/demo/settings/factory-definition?draft=${target.id}&test=${id}#candidate-tests`,
} satisfies ComponentProps<typeof CandidateTestPanel>;

afterEach(cleanup);

it("supports keyboard start, announces pending and running states, and cancels the exact request", async () => {
  const user = userEvent.setup();
  const onStart = vi.fn();
  const onCancel = vi.fn();
  const { rerender } = render(
    <CandidateTestPanel {...baseProps} onStart={onStart} onCancel={onCancel} />,
  );
  expect(screen.getByRole("region", { name: "Draft configuration tests" })).toBeVisible();
  expect(screen.getByText(target.digest)).toBeVisible();
  expect(screen.getByText("Not tested")).toBeVisible();
  const run = screen.getByRole("button", { name: "Run configuration test" });
  await user.tab();
  expect(run).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onStart).toHaveBeenCalledTimes(1);

  rerender(<CandidateTestPanel {...baseProps} onStart={onStart} pending="start" />);
  expect(screen.getByText("Queued")).toBeVisible();
  expect(screen.getByRole("button", { name: "Requesting test…" })).toBeDisabled();

  const running: CandidateSmokeTest = {
    ...failed,
    status: "running",
    finishedAt: null,
    error: null,
  };
  rerender(<CandidateTestPanel {...baseProps} onCancel={onCancel} tests={[running]} />);
  expect(screen.getAllByText("Running")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Retest configuration" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel test" }));
  expect(onCancel).toHaveBeenCalledWith(latestId);

  rerender(<CandidateTestPanel {...baseProps} pending="cancel" tests={[running]} />);
  expect(screen.getByRole("button", { name: "Canceling…" })).toBeDisabled();
});

it("keeps prior receipts and opens evidence for only the selected digest and test ID", async () => {
  const user = userEvent.setup();
  const onSelectTest = vi.fn();
  const tests = [{ ...failed, status: "unsupported" as const }, passed];
  const eligibility = {
    eligible: false,
    reason: "A current passing test is required.",
    activationNumber: 2,
  };
  const selectedTest: CandidateSmokeTest = {
    ...passed,
    evidence: {
      runtimeProfile: "vercel",
      completedStageCount: 2,
      stageCount: 2,
      stages: [{ stageId: "83c69c29-f04b-4982-90d8-23e4ea0b407f", promptDigest }],
    },
  };
  const panel = { ...baseProps, tests, eligibility, onSelectTest };
  const { rerender } = render(<CandidateTestPanel {...panel} selectedTest={selectedTest} />);
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(screen.getByText("A current passing test is required.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Test evidence" })).toBeNull();
  expect(screen.queryByText(promptDigest)).toBeNull();

  const receiptList = screen.getByRole("list", { name: "Configuration test receipts" });
  const [latest, prior] = within(receiptList).getAllByRole("listitem");
  expect(within(latest).getByText("Unavailable")).toBeVisible();
  expect(within(prior).getByText("Passed")).toBeVisible();
  const priorButton = within(prior).getByRole("button", { name: /^View evidence/ });
  expect(within(prior).getByRole("link", { name: /^Open test/ })).toHaveAttribute(
    "href",
    baseProps.evidenceHref(priorId),
  );
  await user.click(priorButton);
  expect(onSelectTest).toHaveBeenCalledWith(priorId);
  rerender(<CandidateTestPanel {...panel} evidenceLoading selectedTestId={priorId} />);
  expect(screen.getByText("Loading test evidence…")).toBeVisible();
  expect(priorButton).toHaveFocus();

  rerender(
    <CandidateTestPanel
      {...panel}
      selectedTest={{ ...selectedTest, definitionDigest: "d".repeat(64) }}
      selectedTestId={priorId}
    />,
  );
  expect(screen.queryByText(promptDigest)).toBeNull();
  rerender(<CandidateTestPanel {...panel} selectedTest={selectedTest} selectedTestId={priorId} />);
  expect(within(prior).getByText("2 of 2")).toBeVisible();
  expect(within(prior).getByText(promptDigest)).toBeVisible();
  expect(priorButton).toHaveAttribute("aria-expanded", "true");
  expect(priorButton).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onSelectTest).toHaveBeenLastCalledWith(null);
});

it("keeps historical evidence read-only and provides independent retries for list and evidence errors", async () => {
  const user = userEvent.setup();
  const onRefresh = vi.fn();
  const onSelectTest = vi.fn();
  render(
    <CandidateTestPanel
      {...baseProps}
      error="Could not load configuration tests."
      evidenceError="Could not load this receipt."
      onRefresh={onRefresh}
      onSelectTest={onSelectTest}
      purpose="history"
      selectedTestId={priorId}
      tests={[passed]}
    />,
  );
  expect(
    screen.queryByRole("button", { name: /Run configuration|Retest configuration|Cancel test/ }),
  ).toBeNull();
  expect(screen.getByText("Could not load configuration tests.")).toHaveAttribute("role", "alert");
  expect(screen.getByText("Could not load this receipt.")).toHaveAttribute("role", "alert");
  await user.click(screen.getByRole("button", { name: "Retry loading tests" }));
  await user.click(screen.getByRole("button", { name: "Retry loading evidence" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(onSelectTest).toHaveBeenCalledWith(priorId);
});

it("suppresses positive readiness when the current eligibility cannot be verified", () => {
  const props = {
    ...baseProps,
    eligibility: { eligible: true, reason: null, activationNumber: 2 },
  };
  const { rerender } = render(<CandidateTestPanel {...props} />);
  expect(screen.getByText("Ready to publish this draft.")).toBeVisible();

  rerender(
    <CandidateTestPanel
      {...props}
      allowStart={false}
      disableReason="Save changes before testing."
    />,
  );
  expect(screen.queryByText("Ready to publish this draft.")).toBeNull();
  expect(screen.getByRole("button", { name: "Run configuration test" })).toBeDisabled();
  expect(screen.getByText("Save changes before testing.")).toBeVisible();

  rerender(<CandidateTestPanel {...props} error="Could not refresh test eligibility." />);
  expect(screen.queryByText("Ready to publish this draft.")).toBeNull();
  expect(screen.getByText("Activation eligibility is unavailable.")).toBeVisible();
});

it("shows earlier passing receipts without showing a pass for the current activation", () => {
  const { rerender } = render(<CandidateTestPanel {...baseProps} tests={[passed]} />);
  expect(screen.getByText("Not tested")).toBeVisible();
  expect(screen.getByText("Run a test for this draft.")).toBeVisible();
  const receipts = screen.getByRole("list", { name: "Configuration test receipts" });
  expect(within(receipts).getByText("Passed")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retest configuration" })).toBeEnabled();

  // The current activation remains known during eligibility refresh.
  rerender(<CandidateTestPanel {...baseProps} eligibility={null} tests={[passed]} />);
  expect(screen.getByText("Not tested")).toBeVisible();
  expect(within(receipts).getByText("Passed")).toBeVisible();
});
