// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(
      within(batch).getByText(/Failed or canceled runs keep this feedback intact/),
    ).toBeVisible();
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
