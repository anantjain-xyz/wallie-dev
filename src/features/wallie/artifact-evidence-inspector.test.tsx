// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactEvidenceInspector } from "./artifact-evidence-inspector";
import type { InspectedArtifact } from "./artifact-evidence-inspector-data";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const reportId = "55555555-5555-4555-8555-555555555555";
const otherRunId = "66666666-6666-4666-8666-666666666666";
const catalogPath = `/api/workspaces/${workspaceId}/runs/${runId}/artifacts`;
const exactPath = `${catalogPath}/stage_markdown/${artifactId}`;
const reportPath = `${catalogPath}/validation_report/${reportId}`;
const provenancePath = `/api/sessions/${sessionId}/artifacts/${artifactId}/provenance`;
const runSource = { kind: "run", workspaceId, runId, artifactId } as const;
const reviewSource = { kind: "review", sessionId, artifactId } as const;

const artifact: InspectedArtifact = {
  id: artifactId,
  kind: "stage_markdown",
  label: "Release summary",
  digest: { algorithm: "sha256", value: "d".repeat(64) },
  contentType: "text/markdown",
  sizeBytes: 52,
  availability: "available",
  downloadable: true,
  producer: { runId, sessionId, attemptCount: 2 },
  checkpoint: { runId, commitSha: "c".repeat(40) },
  validation: { runId, commitSha: "c".repeat(40), treeSha: "e".repeat(40) },
  recordedAt: "2026-11-15T01:15:03.856332+00:00",
};
const report: InspectedArtifact = {
  ...artifact,
  id: reportId,
  kind: "validation_report",
  label: "Unit tests",
  contentType: "text/plain",
  availability: "recorded",
};

const fetchMock = vi.fn<typeof fetch>();

function trigger() {
  return screen.getByRole("button", { name: "Inspect artifact provenance" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("artifact provenance inspector", () => {
  it("opens the same immutable artifact from a run or review without loading history", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ artifact }));
    const { rerender } = render(<ArtifactEvidenceInspector source={runSource} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());
    const output = await screen.findByText("Release summary");
    expect(output.textContent).toBe("Release summary");
    expect(screen.getByText("Agent-authored output")).toBeTruthy();
    expect(screen.getByText(artifactId)).toBeTruthy();
    expect(screen.getByText("d".repeat(64))).toBeTruthy();
    expect(screen.getByText("e".repeat(40))).toBeTruthy();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([exactPath]);

    fetchMock
      .mockResolvedValueOnce(Response.json({ workspaceId, workspaceSlug: "demo", runId }))
      .mockResolvedValueOnce(Response.json({ artifact }));
    rerender(<ArtifactEvidenceInspector source={reviewSource} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Release summary")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger());
    await screen.findByText("Release summary");
    expect(screen.getByText(artifactId)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open producing run" }).getAttribute("href")).toBe(
      `/w/demo/runs/${runId}`,
    );
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      exactPath,
      provenancePath,
      exactPath,
    ]);
  });

  it("loads catalog pages and checks an exact harness report only on explicit actions", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ artifact }));
    render(<ArtifactEvidenceInspector source={runSource} />);
    fireEvent.click(trigger());

    const browse = await screen.findByRole("button", { name: "Browse run artifacts" });
    browse.focus();
    fetchMock.mockResolvedValueOnce(Response.json({ items: [report], nextCursor: "page2" }));
    fireEvent.click(browse);
    const row = await screen.findByRole("list", { name: "Artifacts from this run" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide run artifacts" }));
    expect(within(row).getByText("Harness report", { exact: false })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([exactPath, catalogPath]);

    const more = screen.getByRole("button", { name: "Load more artifacts" });
    more.focus();
    fetchMock.mockResolvedValueOnce(Response.json({ items: [report, artifact], nextCursor: null }));
    fireEvent.click(more);
    expect(await screen.findByRole("button", { name: "All artifacts loaded" })).toBe(more);
    expect(document.activeElement).toBe(more);
    expect(screen.getAllByRole("button", { name: "Inspect Unit tests" })).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      Response.json({ artifact: { ...report, availability: "missing", downloadable: false } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect Unit tests" }));
    await screen.findByText(
      "The stored file is missing. Run validation again to capture a new copy.",
    );
    expect(screen.queryByRole("button", { name: "Download privately" })).toBeNull();

    const check = screen.getByRole("button", { name: "Check availability" });
    check.focus();
    const verification = deferred<Response>();
    fetchMock.mockReturnValueOnce(verification.promise);
    fireEvent.click(check);
    expect(document.activeElement).toBe(check);
    expect(check.getAttribute("aria-disabled")).toBe("true");
    await act(() => {
      verification.resolve(Response.json({ artifact: { ...report, availability: "available" } }));
    });
    expect(screen.getByRole("button", { name: "Download privately" })).toBeTruthy();
    expect((document.activeElement as HTMLElement).textContent).toBe(report.label);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      exactPath,
      catalogPath,
      `${catalogPath}?cursor=page2`,
      reportPath,
      reportPath,
    ]);
  });

  it("starts from the first catalog page when no accepted artifact was recorded", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ items: [report], nextCursor: "page2" }));
    render(<ArtifactEvidenceInspector source={{ kind: "run", workspaceId, runId }} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    await screen.findByRole("button", { name: "Inspect Unit tests" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([catalogPath]);
  });

  it("stops an old provenance request when the selected review artifact changes", async () => {
    const previous = deferred<Response>();
    fetchMock.mockReturnValueOnce(previous.promise);
    const { rerender } = render(<ArtifactEvidenceInspector source={reviewSource} />);
    fireEvent.click(trigger());
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    rerender(<ArtifactEvidenceInspector source={{ ...reviewSource, artifactId: reportId }} />);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    await act(() => {
      previous.resolve(Response.json({ workspaceId, workspaceSlug: "demo", runId }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Release summary")).toBeNull();
  });

  it("keeps an unrecorded historical artifact in the review instead of guessing a run", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ workspaceId, workspaceSlug: "demo", runId: null }),
    );
    render(<ArtifactEvidenceInspector source={reviewSource} />);
    fireEvent.click(trigger());
    await screen.findByText(/This artifact has no recorded producing run/);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([provenancePath]);
  });

  it("rejects mismatched exact responses without exposing a download", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        artifact: { ...artifact, producer: { ...artifact.producer, runId: otherRunId } },
      }),
    );
    render(<ArtifactEvidenceInspector source={runSource} />);
    fireEvent.click(trigger());
    await screen.findByRole("alert");
    expect(screen.queryByText("Release summary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download privately" })).toBeNull();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([exactPath]);
  });

  it.each([
    ["expired", "The file has expired. Run validation again to capture current evidence."],
    ["redacted", "The file was withheld. Ask a workspace maintainer about access."],
    [
      "inaccessible",
      "Wallie could not access the file. Ask a workspace maintainer to check storage and permissions.",
    ],
    [
      "integrity_mismatch",
      "The file differs from its receipt. Run validation again or ask a maintainer to investigate.",
    ],
    ["unavailable", "Wallie could not check the file. Check availability again."],
  ] as const)(
    "shows an actionable reason for %s without issuing a download",
    async (availability, reason) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ artifact: { ...artifact, availability, downloadable: false } }),
      );
      render(<ArtifactEvidenceInspector source={runSource} />);
      fireEvent.click(trigger());
      await screen.findByText(reason);
      expect(screen.queryByRole("button", { name: "Download privately" })).toBeNull();
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([exactPath]);
    },
  );

  it("keeps late storage denials in the inspector and moves focus to the selected artifact", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ artifact }));
    render(<ArtifactEvidenceInspector source={runSource} />);
    fireEvent.click(trigger());
    const download = await screen.findByRole("button", { name: "Download privately" });
    download.focus();
    fetchMock.mockResolvedValueOnce(Response.json({ availability: "redacted" }, { status: 409 }));
    fireEvent.click(download);

    await screen.findByText("The file was withheld. Ask a workspace maintainer about access.");
    expect(screen.queryByRole("button", { name: "Download privately" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(artifact.label)));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      exactPath,
      `${exactPath}?download=1`,
    ]);
  });
});
