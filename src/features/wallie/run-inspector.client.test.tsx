// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRunCatalogItem } from "@/features/wallie/run-catalog";
import type { RunCatalogRecovery } from "@/features/wallie/run-catalog-recovery";
import { RunInspector } from "@/features/wallie/run-inspector";
import type {
  RunInspectorArtifact,
  RunInspectorContext,
  RunInspectorExecutionProfile,
  RunInspectorRoutingDecision,
  RunInspectorSkills,
} from "@/features/wallie/run-inspector-data";
import { parseRunFailure } from "@/lib/pipeline/run-failure";

const now = "2026-11-14T20:00:00.000Z";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const artifact: RunInspectorArtifact = {
  kind: "available",
  id: "00000000-0000-4000-8000-000000000005",
  stageSlug: "build",
  version: 2,
  createdAt: now,
  href: "/w/wallie/sessions/42?artifactStage=build&artifactVersion=2&artifactId=00000000-0000-4000-8000-000000000005",
};
const recovery: RunCatalogRecovery = {
  metadataAvailable: true,
  queue: { state: "current", status: "success", attemptCount: 4, scheduledAt: null },
  publication: null,
  sourceRecoveryRequired: false,
  retryCheckpointAvailable: false,
  activity: { state: "unknown", observedAt: now, thresholdMs: 900_000 },
  worker: { state: "unobserved", deadlineAt: null, dispatchedAt: null, executionStartedAt: null },
};
const run: WorkspaceRunCatalogItem = {
  id: "00000000-0000-4000-8000-000000000002",
  factoryId: workspaceId,
  sessionId: "00000000-0000-4000-8000-000000000003",
  sessionNumber: 42,
  sessionTitle: "Build workspace run inspector",
  sessionRunHref: "/w/wallie/sessions/42#wallie-run-00000000-0000-4000-8000-000000000002",
  attemptCount: 4,
  stageOrdinal: 6,
  newerRunId: null,
  stageId: "00000000-0000-4000-8000-000000000004",
  stageName: "Build",
  modelProvider: "codex",
  modelName: "gpt-5",
  status: "success",
  interrupted: false,
  failure: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
  lastActivityAt: now,
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalCostUsd: null,
    tokenProvenance: "unavailable",
    costProvenance: "unavailable",
    finalized: true,
  },
  transcript: {
    expiredAt: null,
    hasEvents: true,
    captureEnded: true,
    captureInterrupted: false,
  },
  recovery,
};

const historicalDecision = {
  kind: "recorded",
  receipt: {
    factoryId: workspaceId,
    canManageFactory: true,
    taskClassName: "Original verification",
    decision: {
      version: 1,
      mode: "shadow",
      policyRevisionId: artifact.id,
      policyDigest: "a".repeat(64),
      taskClassSlug: "verify",
      taskClassId: run.stageId ?? null,
      ruleId: "00000000-0000-4000-8000-000000000016",
      initialReason: null,
      disposition: "selected",
      source: "primary",
      reason: "qualified",
      configuration: {
        modelKey: "openai/gpt-5.5",
        harness: "codex",
        workerRuntime: "workerd",
        agentId: run.id,
        definitionRevisionId: "00000000-0000-4000-8000-000000000019",
        qualificationId: run.sessionId,
        experimentId: "00000000-0000-4000-8000-000000000021",
        scorerRevisionId: "00000000-0000-4000-8000-000000000022",
      },
      benchmarkCandidateKey: "b".repeat(64),
    },
    benchmarkEvidence: {
      version: 1,
      experimentId: "00000000-0000-4000-8000-000000000021",
      candidateKey: "b".repeat(64),
      suite: {
        id: "00000000-0000-4000-8000-000000000023",
        revisionId: "00000000-0000-4000-8000-000000000024",
        purpose: "holdout",
        name: "Verification suite",
      },
      scorerRevisionId: "00000000-0000-4000-8000-000000000022",
      scorerName: "Release accuracy",
      taskClassName: "Original verification",
      definitionDigest: "c".repeat(64),
      replayPolicyRevisionId: "00000000-0000-4000-8000-000000000025",
      replayPolicyDigest: "d".repeat(64),
      ruleId: "00000000-0000-4000-8000-000000000016",
      capturedAt: now,
      qualityPassRateBps: 9_200,
      resolvedTrials: 12,
      measuredMeanCostUsd: "0.08",
      constraints: {
        qualityFloorBps: 8_000,
        minResolvedTrials: 5,
        maxMeanCostUsd: null,
        maxLatencyMs: null,
        minConfidenceBps: null,
      },
      p95WallLatencyMs: 1_506,
      isRecommended: true,
    },
  },
} satisfies RunInspectorRoutingDecision;

function show(
  changes: Partial<WorkspaceRunCatalogItem> = {},
  artifact: RunInspectorArtifact = { kind: "none" },
  skills: RunInspectorSkills = { kind: "unrecorded" },
  executionProfile?: RunInspectorExecutionProfile,
  routingDecision?: RunInspectorRoutingDecision,
  canOpenRoutingPolicy = false,
  options: {
    executionProfileAttempt?: number;
    frozenContext?: RunInspectorContext;
    newerRunHref?: string;
    returnTo?: { href: string; label: string };
  } = {},
) {
  return render(
    <RunInspector
      artifact={artifact}
      canOpenRoutingPolicy={canOpenRoutingPolicy}
      executionProfile={executionProfile}
      initialNow={now}
      names={{
        agents: { [run.id]: "Release agent" },
        members: {
          [run.sessionId]: { label: "Riley · Member", active: true },
          [workspaceId]: { label: "Morgan · Former member", active: false },
        },
        principals: {},
        promptRevisionNumber: 3,
      }}
      routingDecision={routingDecision}
      run={{ ...run, ...changes }}
      skills={skills}
      workspaceId={workspaceId}
      workspaceSlug="wallie"
      transcript={<p>Exact attempt activity</p>}
      {...options}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function routingPanel() {
  const panel = screen.getByRole("heading", { name: "Routing decision" }).closest("section");
  if (!panel) throw new Error("Missing routing decision section.");
  return within(panel);
}

describe("RunInspector", () => {
  it("shows the original routing policy and exact frozen benchmark qualification", () => {
    show(
      { modelName: "actual-execution-model" },
      undefined,
      undefined,
      undefined,
      historicalDecision,
      true,
    );
    const routing = routingPanel();
    const { decision, benchmarkEvidence } = historicalDecision.receipt;
    expect(routing.getByText("Original verification")).toBeTruthy();
    expect(routing.getByText("Primary configuration")).toBeTruthy();
    expect(routing.getByText("Shadow only — not applied")).toBeTruthy();
    expect(routing.getByRole("heading", { name: "Would select" })).toBeTruthy();
    expect(routing.getByText(decision.ruleId)).toBeTruthy();
    expect(routing.getByText("openai/gpt-5.5")).toBeTruthy();
    expect(routing.getByText("Release accuracy")).toBeTruthy();
    expect(routing.getByText("92%")).toBeTruthy();
    expect(screen.getByText(/actual-execution-model/)).toBeTruthy();
    expect(
      routing.getByRole("link", { name: "Open recorded policy revision" }).getAttribute("href"),
    ).toBe(
      `/w/wallie/settings/factory-definition?factory=${workspaceId}&revision=${decision.policyRevisionId}`,
    );
    const href = routing
      .getByRole("link", { name: "Open exact comparison configuration" })
      .getAttribute("href");
    const link = new URL(href ?? "", "http://localhost");
    expect(link.pathname).toBe(
      `/w/wallie/benchmarks/${benchmarkEvidence.suite.id}/comparisons/${benchmarkEvidence.experimentId}`,
    );
    expect(Object.fromEntries(link.searchParams)).toEqual({
      factory: workspaceId,
      scorerRevisionId: benchmarkEvidence.scorerRevisionId,
      qualityFloorPercent: "80",
      minResolvedTrials: "5",
      routingCandidateKey: benchmarkEvidence.candidateKey,
    });
    expect(link.hash).toBe(`#frontier-configuration-${benchmarkEvidence.candidateKey}`);
  });

  it("keeps benchmark links available to delegated factory managers", () => {
    show({}, undefined, undefined, undefined, historicalDecision);
    const routing = routingPanel();
    const { policyRevisionId } = historicalDecision.receipt.decision;
    expect(routing.getByText(policyRevisionId)).toBeTruthy();
    expect(routing.queryByRole("link", { name: "Open recorded policy revision" })).toBeNull();
    expect(routing.getByRole("link", { name: "Open exact comparison configuration" })).toBeTruthy();
    expect(routing.getByRole("link", { name: "Open frozen suite revision" })).toBeTruthy();
  });

  it("shows the override actor and target alongside the original recommendation", () => {
    const { receipt } = historicalDecision;
    show({}, undefined, undefined, undefined, {
      kind: "recorded",
      receipt: {
        ...receipt,
        decision: { ...receipt.decision, mode: "active" },
        override: {
          actorMemberId: workspaceId,
          reason: "Use the approved backup for this one session.",
          target: "rule_fallback",
          configuration: { ...receipt.decision.configuration, modelKey: "openai/gpt-4.1" },
          benchmarkCandidateKey: "e".repeat(64),
          createdAt: run.startedAt ?? "2026-11-21T12:00:00.000Z",
        },
      },
    });
    const routing = routingPanel();
    expect(routing.getByText("Override recorded")).toBeTruthy();
    expect(routing.getByText("Use the approved backup for this one session.")).toBeTruthy();
    expect(routing.getByText("Morgan · Former member")).toBeTruthy();
    expect(routing.getByText(workspaceId)).toBeTruthy();
    expect(routing.getByText("openai/gpt-4.1")).toBeTruthy();
    expect(routing.getByText("openai/gpt-5.5")).toBeTruthy();
    expect(routing.getByRole("link", { name: "Open exact comparison configuration" })).toBeTruthy();
  });

  it("keeps the fallback reason visible when the reviewer cannot manage the factory", () => {
    const { receipt } = historicalDecision;
    show({}, undefined, undefined, undefined, {
      kind: "recorded",
      receipt: {
        ...receipt,
        canManageFactory: false,
        benchmarkEvidence: null,
        decision: {
          ...receipt.decision,
          source: "rule_fallback",
          initialReason: "credential_unavailable",
        },
      },
    });
    const routing = routingPanel();
    expect(routing.getByText("Rule fallback")).toBeTruthy();
    expect(routing.getByText("The required credential is unavailable.")).toBeTruthy();
    expect(routing.getByText(/Benchmark proposal details require permission/)).toBeTruthy();
    expect(routing.getByText(receipt.decision.benchmarkCandidateKey)).toBeTruthy();
    expect(routing.queryByRole("link")).toBeNull();
  });

  it.each([
    ["unrecorded", "Not recorded"],
    ["unavailable", "Unavailable"],
  ] as const)("shows a clear %s routing state", (kind, message) => {
    show({}, undefined, undefined, undefined, { kind });
    const records = within(screen.getByRole("region", { name: "Diagnostic records" }));
    const routing = records.getByText("Routing decision").parentElement;
    expect(routing?.id).toBe("routing-decision");
    expect(routing?.querySelector("dd")?.textContent).toBe(message);
    expect(records.queryByRole("link")).toBeNull();
  });

  it("consolidates gaps in diagnostic records without conflating them or losing anchors", () => {
    show(
      {},
      { kind: "none" },
      { kind: "unavailable" },
      { kind: "unrecorded" },
      { kind: "unrecorded" },
      false,
      { executionProfileAttempt: 2, frozenContext: { kind: "unavailable" } },
    );
    const records = within(screen.getByRole("region", { name: "Diagnostic records" }));
    expect(records.getAllByText("Unavailable")).toHaveLength(2);
    expect(records.getAllByText("Not recorded")).toHaveLength(2);
    expect(records.getByText("Frozen inputs").parentElement?.id).toBe("frozen-inputs");
    expect(records.getByText("Execution profile (job attempt 2)").parentElement?.id).toBe(
      "execution-profile",
    );
    expect(
      records.getByText("Skill revisions").parentElement?.querySelector("dd")?.textContent,
    ).toBe("Unavailable");
    expect(screen.queryByRole("heading", { name: "Routing decision" })).toBeNull();
    expect(screen.getByText("No artifact was accepted.")).toBeTruthy();
  });

  it("displays the recorded execution profile for this attempt", () => {
    show({ modelName: "current-catalog-model" }, undefined, undefined, {
      kind: "recorded",
      profile: {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        effort: "high",
        maxTurns: 5,
        sandboxProvider: "e2b",
        sandboxConnectionRevision: artifact.id,
        workerRuntime: "workerd",
        definitionRevisionId: artifact.id,
        factoryId: workspaceId,
        agentId: run.id,
        promptRevisionId: artifact.id,
        invokingMemberId: run.sessionId,
        triggeredByMemberId: null,
        authority: { kind: "human", memberId: workspaceId },
      },
    });
    expect(screen.getByRole("heading", { name: "Recorded execution profile" })).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(screen.getByText("Workerd")).toBeTruthy();
    expect(screen.getByText("Morgan · Former member")).toBeTruthy();
    expect(screen.getByText("Release agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open prompt revision 3" }).getAttribute("href")).toBe(
      `/w/wallie/agents/${run.id}?factory=${workspaceId}&revision=${artifact.id}`,
    );
    expect(
      screen
        .getByRole("link", { name: "View invoking member activity: Riley · Member" })
        .getAttribute("href"),
    ).toBe(`/w/wallie/activity?factory=${workspaceId}&actor=${run.sessionId}`);
    expect(screen.queryByText(/current-catalog-model/)).toBeNull();
  });
  it("shows the durable attempt, source session and exact accepted artifact link", () => {
    const href = "/w/wallie/runs?status=error&cursor=opaque&factory=all";
    show({}, artifact, undefined, undefined, undefined, false, {
      returnTo: { href, label: "Back to filtered runs" },
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(run.sessionTitle);
    expect(screen.getByText("Build · Attempt 6")).toBeTruthy();
    expect(screen.getByText(run.id)).toBeTruthy();
    const back = screen.getByRole("link", { name: "Back to filtered runs" });
    expect(back.getAttribute("href")).toBe(href);
    expect(back.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open session #42" }).getAttribute("href")).toBe(
      run.sessionRunHref,
    );
    expect(screen.getByRole("link", { name: "build · Version 2" }).getAttribute("href")).toBe(
      artifact.href,
    );
    expect(screen.getByText("Exact attempt activity")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Transcript" }).getAttribute("href")).toBe(
      "#run-transcript",
    );
    expect(screen.getByRole("link", { name: "Evidence" }).getAttribute("href")).toBe(
      "#run-evidence",
    );
    expect(screen.getByText("Cost unavailable")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("loads only the accepted artifact when the run disclosure opens", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    show({}, artifact);

    const disclosure = screen.getByRole("button", { name: "Inspect artifact provenance" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(disclosure);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/workspaces/${workspaceId}/runs/${run.id}/artifacts/stage_markdown/${artifact.id}`,
      expect.anything(),
    );
    expect(screen.getByText("Exact attempt activity")).toBeTruthy();
  });

  it("identifies each retained skill revision and its content digest", () => {
    const revisionId = "00000000-0000-4000-8000-000000000007";
    const digest = "a".repeat(64);
    show(
      {},
      { kind: "none" },
      {
        kind: "recorded",
        revisions: [
          {
            skillId: "00000000-0000-4000-8000-000000000006",
            name: "Check release evidence",
            revisionId,
            version: 2,
            contentSha256: digest,
            sourceKind: "repository",
          },
        ],
      },
    );
    expect(screen.getByRole("heading", { name: "Skill revisions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Check release evidence" })).toBeTruthy();
    expect(screen.getByText("Revision 2 · Repository")).toBeTruthy();
    expect(screen.getByText(revisionId)).toBeTruthy();
    expect(screen.getByText(digest)).toBeTruthy();
  });

  it("distinguishes unrecorded skills from a recorded empty set", () => {
    const view = show();
    const records = within(screen.getByRole("region", { name: "Diagnostic records" }));
    const skills = records.getByText("Skill revisions").parentElement;
    expect(skills?.querySelector("dd")?.textContent).toBe("Not recorded");

    view.unmount();
    show({}, undefined, { kind: "recorded", revisions: [] });
    expect(screen.queryByText("Skill revisions")).toBeNull();
  });

  it("keeps cancellation visible even when a newer attempt exists", () => {
    const nextId = "00000000-0000-4000-8000-000000000006";
    const next = `/w/wallie/runs/${nextId}`;
    show(
      {
        status: "canceled",
        newerRunId: nextId,
        recovery: {
          ...recovery,
          queue: { state: "superseded", status: "running", attemptCount: 5, scheduledAt: now },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { newerRunHref: next },
    );
    expect(screen.getByLabelText("Canceled. Work was canceled.")).toBeTruthy();
    expect(screen.getByText("This attempt was canceled.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A newer attempt exists" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next attempt" }).getAttribute("href")).toBe(next);
    expect(screen.queryByLabelText("Running. Work is in progress.")).toBeNull();
  });

  it("shows safe failure cause and scheduled recovery without relabeling the failed attempt", () => {
    show({
      status: "error",
      failure: parseRunFailure('{"version":1,"code":"agent_exit","category":"agent_exit"}'),
      recovery: {
        ...recovery,
        queue: { state: "retry_scheduled", status: "queued", attemptCount: 4, scheduledAt: now },
      },
    });
    expect(screen.getByLabelText("Failed. Work stopped because of an error.")).toBeTruthy();
    expect(
      screen.getByText("The agent process exited unsuccessfully before completing the run."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retry scheduled" })).toBeTruthy();
    expect(screen.getByText(/Scheduled for/).querySelector("time")?.dateTime).toBe(now);
  });

  it("distinguishes pending publication from a retry", () => {
    show({
      status: "running",
      recovery: {
        ...recovery,
        publication: {
          status: "pending",
          deadlineAt: now,
          deadlineExpired: false,
          nextAttemptAt: now,
          attemptCount: 2,
          leaseExpiresAt: null,
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Publishing saved output" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Review before retrying" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open artifact" })).toBeNull();
  });

  it("states the limits of stale activity without claiming a stopped worker", () => {
    show({
      status: "running",
      finishedAt: null,
      recovery: { ...recovery, activity: { ...recovery.activity, state: "stale" } },
    });
    expect(screen.getByRole("heading", { name: "No recent activity" })).toBeTruthy();
    expect(screen.getByText(/does not confirm that the worker stopped/)).toBeTruthy();
  });

  it("keeps unrecorded attempt and artifact uncertainty explicit", () => {
    show({ attemptCount: null, recovery: null }, { kind: "unrecorded" });
    expect(screen.getByText("Build · Attempt 6")).toBeTruthy();
    expect(screen.getByText("An exact artifact link was not recorded for this run.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recovery details unavailable" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open artifact" })).toBeNull();
  });

  it("labels estimated partial usage separately from unavailable usage", () => {
    show({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0,
        tokenProvenance: "estimated",
        costProvenance: "estimated",
        finalized: false,
      },
    });
    expect(screen.getByText("100 in · 50 out · estimated · Not final")).toBeTruthy();
    expect(screen.getByText("$0.00 estimated · Not final")).toBeTruthy();
  });
});
