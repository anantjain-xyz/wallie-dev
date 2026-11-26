// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { BenchmarkAxisCatalog } from "@/lib/factory-benchmarks/experiment-axes-contracts";

import { BenchmarkComparisonForm } from "./benchmark-comparison-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const id = (part: number) => `61900000-0000-4000-8000-${String(part).padStart(12, "0")}`;
const modelKey = "openai/gpt-4.1-2025-04-14";
const profile: BenchmarkAxisCatalog["profiles"][number] = {
  id: id(10),
  modelKey,
  harness: "codex",
  harnessModel: "gpt-4.1-2025-04-14",
  workerRuntime: "workerd",
  sandboxProvider: "vercel",
  sandboxConnectionRevision: id(11),
  toolchain: "Codex 0.88.0",
  toolchainDigest: "a".repeat(64),
  connectionName: "Benchmark project",
  checkedAt: "2026-11-24T08:00:00Z",
  definitionIds: [id(7), id(8)],
  unavailableReason: null,
};
const options: BenchmarkAxisCatalog = {
  definitions: [
    {
      id: id(7),
      digest: "b".repeat(64),
      label: "First activated as 7 · Plan → Review",
      isCurrent: true,
    },
    {
      id: id(8),
      digest: "c".repeat(64),
      label: "First activated as 2 · Plan → Validate",
      isCurrent: false,
    },
  ],
  policies: [{ id: id(9), profile: "blocked", revisionNumber: 2 }],
  profiles: [profile],
  scorerRevisions: [],
};
const scope = {
  workspaceId: id(1),
  workspaceSlug: "acme",
  factoryId: id(2),
  suiteId: id(3),
  suiteRevisionId: id(4),
  suiteRevisionNumber: 5,
  taskCount: 2,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function choose(picker: HTMLElement, label: string | RegExp) {
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: label }));
}

function choosePair() {
  for (const side of ["Baseline", "Candidate"]) {
    const fields = within(screen.getByRole("group", { name: side }));
    choose(fields.getByRole("combobox", { name: "Model", exact: true }), modelKey);
    choose(fields.getByRole("combobox", { name: "Harness" }), "Codex");
    choose(fields.getByRole("combobox", { name: "Worker runtime" }), "Cloudflare Workers");
    if (side === "Baseline") {
      fireEvent.click(fields.getByRole("button", { name: "Use current revision" }));
    } else {
      choose(fields.getByRole("combobox", { name: "Factory revision" }), /Plan → Validate/);
    }
  }
  choose(screen.getByRole("combobox", { name: "Replay policy revision" }), "Revision 2 · Blocked");
}

it("retains the reviewable suite revision and blocks a changed digest until intentionally reselected", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    const command = JSON.parse(String(init?.body));
    return Response.json({
      experimentId: command.experimentId,
      suiteRevisionId: scope.suiteRevisionId,
      policyRevisionId: options.policies[0].id,
      repetitions: 3,
      taskCount: scope.taskCount,
      candidateCount: 2,
      expectedTrialCount: 12,
      materializedTrialCount: 12,
      eligibleTrialCount: 6,
      ineligibleTrialCount: 6,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const { rerender } = render(<BenchmarkComparisonForm {...scope} options={options} />);
  choosePair();
  expect(screen.getByText("Suite revision 5 · 2 tasks")).toBeVisible();
  const freeze = screen.getByRole("button", { name: "Freeze comparison" });
  expect(freeze).toBeEnabled();

  const changed = { ...profile, toolchainDigest: "d".repeat(64) };
  rerender(<BenchmarkComparisonForm {...scope} options={{ ...options, profiles: [changed] }} />);
  expect(freeze).toBeDisabled();
  expect(screen.getAllByText(/The selected toolchain changed or is unavailable/)).toHaveLength(2);
  fireEvent.submit(screen.getByRole("form", { name: "Benchmark comparison" }));
  expect(fetch).not.toHaveBeenCalled();

  for (const side of ["Baseline", "Candidate"]) {
    const fields = within(screen.getByRole("group", { name: side }));
    choose(
      fields.getByRole("combobox", { name: "Qualified toolchain" }),
      /Codex 0.88.0 · Vercel · Benchmark project · Checked/,
    );
  }
  fireEvent.click(freeze);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const command = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(command).toMatchObject({
    suiteRevisionId: scope.suiteRevisionId,
    candidates: [id(7), id(8)].map((definitionRevisionId) => ({
      definitionRevisionId,
      qualificationId: profile.id,
      workerRuntime: "workerd",
      expectedToolchainDigest: changed.toolchainDigest,
    })),
  });
  expect(await screen.findByText(/Trials haven’t started/)).toBeVisible();
});

it("does not submit an intentionally saved empty revision", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<BenchmarkComparisonForm {...scope} options={options} taskCount={0} />);
  choosePair();
  expect(screen.getByText(/An empty suite can be saved/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Freeze comparison" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Benchmark comparison" }));
  expect(fetch).not.toHaveBeenCalled();
});
