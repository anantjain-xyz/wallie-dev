// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocalizedTimestamp } from "@/components/shared/time-format";
import { RevisionReviewPanel } from "./revision-review-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const history = {
  batches: [
    {
      id: "batch-a",
      artifact_version: 1,
      actor_label: "Reviewer A",
      created_at: "2026-11-05",
      run_id: "run-1",
    },
    {
      id: "batch-b",
      artifact_version: 2,
      actor_label: "Reviewer B",
      created_at: "2026-11-06",
      run_id: "run-2",
    },
  ],
  nextCursor: null,
  producingRun: null,
  receivedBatchId: "batch-a",
};
const threads = {
  threads: [
    {
      id: "mapped",
      artifact_id: "old",
      artifact_version: 1,
      status: "open",
      kind: "blocking",
      author_label: "Reviewer A",
      anchor: { quote: "Unique paragraph" },
    },
    {
      id: "outdated",
      artifact_id: "old",
      artifact_version: 1,
      status: "open",
      kind: "blocking",
      author_label: "Reviewer B",
      anchor: { quote: "Deleted paragraph" },
    },
  ],
  mappings: {
    mapped: { status: "mapped", anchor: { start: 20, end: 36 } },
    outdated: { status: "outdated", reason: "Paragraph was deleted" },
  },
  nextCursor: null,
};
const detail = {
  batch: {
    id: "batch-a",
    artifact_id: "old",
    artifact_version: 1,
    actor_label: "Reviewer A",
    whole_stage_feedback: "",
    rendered_feedback_text: "Saved agent input",
  },
  threads: [
    {
      thread_id: "mapped",
      artifact_id: "old",
      sourceVersion: 1,
      sourceStageSlug: "build",
      kind: "blocking",
      thread_revision: 1,
      anchor: { quote: "Unique paragraph" },
      comments: [
        {
          id: "comment-1",
          author_label: "Reviewer A",
          revision: 1,
          body: "<script>saved comment</script>",
        },
      ],
    },
  ],
  jobStatus: "failed",
  initialRun: {
    id: "run-1",
    status: "failed",
    model_provider: "codex",
    model_name: "test",
    attempt_count: 1,
  },
  outputs: [],
  outputNextCursor: null,
};
function setup(overrides?: (url: string) => Promise<unknown> | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const custom = overrides?.(input);
      const body = custom
        ? await custom
        : input.includes("batchId=")
          ? detail
          : input.includes("feedback-batches")
            ? history
            : input.includes("/reviews?")
              ? threads
              : input.includes("artifactId=old")
                ? { artifact: { id: "old", payload: "Old paragraph\n" } }
                : {
                    artifacts: [
                      { id: "current", version: 2, authorLabel: "Agent" },
                      { id: "old", version: 1, authorLabel: "Agent" },
                    ],
                  };
      return new Response(JSON.stringify(body));
    }),
  );
  return render(
    <RevisionReviewPanel
      sessionId="session"
      artifactId="current"
      version={2}
      stageSlug="build"
      source={"New paragraph\n"}
    />,
  );
}
describe("revision review workspace", () => {
  it("uses readable dates and preserves exact feedback and run provenance behind accessible details", async () => {
    const user = userEvent.setup();
    const submittedAt = "2026-11-07T11:24:50.15687+05:30";
    const batchId = "06326ce1-34ab-4d3a-87e4-487a43d82213";
    const runId = "16c8c3a6-4e65-42af-8496-0a1a87214dd1";
    const run = { ...detail.initialRun, id: runId, status: "completed" };
    setup((url) =>
      url.includes("batchId=")
        ? Promise.resolve({
            ...detail,
            batch: { ...detail.batch, id: batchId, created_at: submittedAt },
          })
        : url.includes("feedback-batches")
          ? Promise.resolve({
              ...history,
              batches: [{ ...history.batches[0], id: batchId, created_at: submittedAt }],
              producingRun: run,
            })
          : undefined,
    );

    const feedback = await screen.findByRole("button", { name: /Feedback on version 1/ });
    const time = feedback.querySelector("time");
    expect(time).toHaveAttribute("dateTime", submittedAt);
    await waitFor(() => expect(time).toHaveTextContent(formatLocalizedTimestamp(submittedAt)));
    expect(time).toHaveAccessibleName(formatLocalizedTimestamp(submittedAt));
    expect(feedback).not.toHaveTextContent(submittedAt);
    expect(feedback).not.toHaveTextContent(batchId.slice(0, 8));
    expect(screen.getByText("Producing run · completed")).toBeVisible();
    expect(screen.getByText("codex · test · Attempt 1")).toBeVisible();
    expect(screen.getByRole("link", { name: "Producing run activity" })).toHaveAttribute(
      "href",
      `#wallie-run-${runId}`,
    );
    expect(screen.getByRole("link", { name: "Producing run for version 2" })).toHaveAttribute(
      "href",
      `#wallie-run-${runId}`,
    );
    expect(screen.getByText(runId)).not.toBeVisible();
    const runDetails = screen.getByText("Run details", { selector: "summary" });
    await user.click(runDetails);
    expect(screen.getByText(runId)).toBeVisible();

    await user.click(feedback);
    const snapshot = within(
      await screen.findByRole("region", { name: "Exact submitted feedback" }),
    );
    expect(snapshot.getByText(batchId)).not.toBeVisible();
    expect(snapshot.getByText(submittedAt)).not.toBeVisible();
    const feedbackDetails = snapshot.getByText("Feedback details", { selector: "summary" });
    await user.click(feedbackDetails);
    expect(snapshot.getByText("Feedback ID")).toBeVisible();
    expect(snapshot.getByText(batchId)).toBeVisible();
    expect(snapshot.getByText("Exact submitted timestamp")).toBeVisible();
    expect(snapshot.getByText(submittedAt)).toBeVisible();
    expect(snapshot.getByRole("link", { name: "Reviewed artifact" })).toHaveAttribute(
      "href",
      "?artifactId=old&artifactVersion=1&artifactStage=build",
    );
    expect(snapshot.getByRole("link", { name: "Initial revision run activity" })).toHaveAttribute(
      "href",
      "#wallie-run-run-1",
    );
    expect(snapshot.getByText("Saved agent input")).toBeInTheDocument();
    expect(snapshot.getByText(/Submitted by Reviewer A/)).toBeVisible();
    expect(snapshot.getByText("<script>saved comment</script>")).toBeVisible();
  });

  it("keeps long author labels intact and uses fallbacks for missing or invalid metadata", async () => {
    const user = userEvent.setup();
    const longAuthor = `Reviewer ${"LongUnbrokenName".repeat(20)}`;
    setup((url) =>
      url.includes("batchId=")
        ? Promise.resolve({
            ...detail,
            batch: { ...detail.batch, actor_label: null, created_at: null },
            initialRun: null,
          })
        : url.includes("feedback-batches")
          ? Promise.resolve({
              ...history,
              batches: [
                { ...history.batches[0], actor_label: longAuthor, created_at: "invalid-date" },
                { ...history.batches[1], actor_label: null, created_at: null },
              ],
              producingRun: {
                ...detail.initialRun,
                model_provider: null,
                model_name: null,
                attempt_count: null,
              },
            })
          : undefined,
    );

    const longLabel = await screen.findByRole("button", { name: /Feedback on version 1/ });
    expect(longLabel).toHaveTextContent(longAuthor);
    expect(longLabel).toHaveAccessibleName(expect.stringContaining(longAuthor));
    expect(within(longLabel).getByText("Unknown time")).toBeVisible();
    expect(longLabel.querySelector("time")).toBeNull();
    const missingMetadata = screen.getByRole("button", {
      name: /Feedback on version 2 · Unknown reviewer/,
    });
    expect(within(missingMetadata).getByText("Unknown time")).toBeVisible();
    expect(missingMetadata.querySelector("time")).toBeNull();
    expect(screen.getByText("Model unavailable · Attempt unknown")).toBeVisible();

    await user.click(missingMetadata);
    const snapshot = within(
      await screen.findByRole("region", { name: "Exact submitted feedback" }),
    );
    expect(snapshot.getByText(/Submitted by Unknown reviewer/)).toBeVisible();
    expect(snapshot.getByText("Initial run unavailable.")).toBeVisible();
    await user.click(snapshot.getByText("Feedback details", { selector: "summary" }));
    expect(snapshot.getByText("Unavailable")).toBeVisible();
  });

  it("compares exact sources and keeps original blocking requests in keyboard-accessible groups", async () => {
    setup();
    expect(await screen.findByText("+ Added")).toBeVisible();
    expect(screen.getByLabelText("Compare version 2 with")).toHaveValue("old");
    const unresolved = within(screen.getByRole("region", { name: "Unresolved feedback" }));
    expect(unresolved.getByText(/Blocking request · Open · Reviewer A/)).toBeVisible();
    expect(unresolved.getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("reviewThread=mapped"),
    );
    expect(
      within(screen.getByRole("region", { name: "Outdated selections" })).getByText(
        "Deleted paragraph",
      ),
    ).toBeVisible();
    const comparison = screen.getByLabelText("Source changes");
    comparison.focus();
    expect(comparison).toHaveFocus();
  });
  it("renders immutable submitted text as escaped text, with failed run and resubmission guidance", async () => {
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "View feedback received by this revision" }),
    );
    const batch = await screen.findByRole("region", { name: "Exact submitted feedback" });
    expect(within(batch).getByText("<script>saved comment</script>")).toBeVisible();
    expect(batch.querySelector("script")).toBeNull();
    expect(within(batch).getByText(/Initial revision run · failed/)).toBeVisible();
    expect(within(batch).getByText(/Feedback kept/)).toBeVisible();
    expect(within(batch).getByText("Saved agent input")).toBeInTheDocument();
  });
  it("ignores stale batch selections arriving out of order", async () => {
    let resolveA!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      resolveA = resolve;
    });
    setup((url) =>
      url.includes("batchId=batch-a")
        ? delayed
        : url.includes("batchId=batch-b")
          ? Promise.resolve({ ...detail, batch: { ...detail.batch, artifact_version: 2 } })
          : undefined,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Feedback on version 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Feedback on version 2/ }));
    await screen.findByText("Exact submitted feedback · Version 2");
    resolveA(detail);
    await waitFor(() =>
      expect(screen.queryByText("Exact submitted feedback · Version 1")).toBeNull(),
    );
  });

  it("loads additional accepted outputs without losing the immutable snapshot", async () => {
    const output = (version: number) => ({
      artifactId: `output-${version}`,
      version,
      runId: `run-${version}`,
      createdAt: "2026-11-05",
      run: null,
    });
    setup((url) =>
      url.includes("batchId=batch-a")
        ? Promise.resolve({
            ...detail,
            outputs: [output(url.includes("cursorId=") ? 2 : 3)],
            outputNextCursor: url.includes("cursorId=")
              ? null
              : { createdAt: "2026-11-05T00:00:00Z", id: "run-3" },
          })
        : undefined,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "View feedback received by this revision" }),
    );
    await screen.findByRole("link", { name: "Output version 3" });
    fireEvent.click(screen.getByRole("button", { name: "Load more revision outputs" }));
    await screen.findByRole("link", { name: "Output version 2" });
    expect(screen.getByRole("link", { name: "Output version 3" })).toBeVisible();
    expect(screen.getByText("<script>saved comment</script>")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more revision outputs" })).toBeNull();
  });
  it("does not display a mismatched artifact as comparison evidence", async () => {
    setup((url) =>
      url.includes("artifactId=old")
        ? Promise.resolve({ artifact: { id: "foreign", payload: "Wrong source" } })
        : undefined,
    );
    expect(await screen.findByText(/Comparison source identity changed/)).toBeVisible();
    expect(screen.queryByLabelText("Source changes")).toBeNull();
  });
});
