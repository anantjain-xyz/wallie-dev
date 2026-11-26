// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunTranscriptPage } from "@/features/wallie/run-transcript-contracts";

import { BenchmarkTrialCitation } from "./benchmark-trial-citation";
import { BenchmarkTrialTranscriptRetry } from "./benchmark-trial-transcript-retry";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const endpoint = "/api/example/trials/trial/transcript";
const initialPage: RunTranscriptPage = {
  runId: "exact-run",
  attemptCount: 1,
  runStatus: "success",
  expiredAt: null,
  olderCursor: null,
  newerCursor: "tail",
  hasOlder: false,
  hasNewer: false,
  entries: [
    {
      id: "event:exact-run:1:1",
      kind: "text",
      payload: { text: "Recovered trial activity" },
      createdAt: "2026-11-21T17:15:00Z",
      sequence: 1,
      causationSequence: null,
      truncated: false,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trial-local evidence controls", () => {
  it("retries only the transcript and restores focus after recovery", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json(initialPage));
    vi.stubGlobal("fetch", request);
    render(
      <>
        <p>Authorized trial score</p>
        <BenchmarkTrialTranscriptRetry
          workspaceId="workspace"
          runId="exact-run"
          attemptCount={1}
          endpoint={endpoint}
        />
      </>,
    );
    const retry = screen.getByRole("button", { name: "Retry transcript" });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByText("Couldn’t load the transcript.");
    expect(screen.getByText("Authorized trial score")).toBeTruthy();
    fireEvent.click(retry);
    await screen.findByText("Recovered trial activity");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      endpoint,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Transcript" }));
  });

  it("does not render an API response belonging to another attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...initialPage, attemptCount: 2 })),
    );
    render(
      <BenchmarkTrialTranscriptRetry
        workspaceId="workspace"
        runId="exact-run"
        attemptCount={1}
        endpoint={endpoint}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry transcript" }));
    await screen.findByText(/This transcript is no longer available/);
    expect(screen.queryByText("Recovered trial activity")).toBeNull();
  });

  it.each([200, 404])("loads an exact citation only on disclosure (HTTP %s)", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json(status === 200 ? { passage: "Exact retained passage" } : {}, { status }),
      );
    const href = "/api/example/trials/trial/citation?index=0";
    vi.stubGlobal("fetch", request);
    render(<BenchmarkTrialCitation href={href} label="Replay artifact · Lines 2–3" />);
    expect(request).not.toHaveBeenCalled();
    const details = screen.getByText("Replay artifact · Lines 2–3").closest("details")!;
    details.open = true;
    await screen.findByText(
      status === 200 ? "Exact retained passage" : "Cited source isn’t viewable here.",
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      href,
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
