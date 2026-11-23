import { expect, it } from "vitest";

import { bindForemanChildRead, bindForemanDelegation, parseForemanPlan } from "./foreman-command";

const scope = {
  rootSessionId: "root-1",
  routeOccurrenceId: "occ-route-1",
  foremanRunId: "foreman-1",
};
const route = {
  kind: "route",
  decision: {
    kind: "choose",
    destinationNodeId: "child.first",
    reason: "The accepted source is ready for this plan.",
    confidence: 0.9,
  },
} as const;
const delegate = {
  kind: "delegate",
  targetNodeId: "child.first",
  title: "Verify the isolated implementation",
  promptMd: "Implement the declared assigned scope. Preserve the parent's accepted source.",
} as const;
const stored = {
  resolution: "selected",
  rootSessionId: scope.rootSessionId,
  routeOccurrenceId: scope.routeOccurrenceId,
  decisionId: "route-receipt-1",
  selectedDestinationId: "child.first",
  targetOccurrenceId: "occ-child-1",
} as const;
const envelope = (...commands: unknown[]) => JSON.stringify({ version: 1, commands });

it("binds one declared delegate intent to the exact committed destination", () => {
  const parsed = parseForemanPlan(envelope(route, delegate));
  expect(parsed.status).toBe("parsed");
  expect(
    bindForemanDelegation({
      scope,
      command: delegate,
      decision: stored,
      declaredTargetIds: new Set(["child.first"]),
    }),
  ).toEqual({
    status: "bound",
    foremanRunId: scope.foremanRunId,
    decisionId: stored.decisionId,
    targetOccurrenceId: stored.targetOccurrenceId,
    work: { title: delegate.title, promptMd: delegate.promptMd },
  });
});

it("admits Unicode titles through the same limits as direct delegation", () => {
  expect(parseForemanPlan(envelope(route, { ...delegate, title: "🧱".repeat(200) }))).toMatchObject(
    {
      status: "parsed",
    },
  );
  expect(parseForemanPlan(envelope(route, { ...delegate, title: "🧱".repeat(201) }))).toMatchObject(
    {
      status: "blocked",
      code: "invalid_plan",
    },
  );
});

it.each([
  [route, { ...delegate, executionGrantId: "broader-grant" }],
  [route, { ...delegate, parentSessionId: "other-root" }],
  [route, { ...delegate, definitionRevisionId: "new-profile" }],
  [route, delegate, delegate],
  [delegate],
  [{ kind: "read_child", childRef: "child-1" }],
  [{ kind: "read_child", childRef: "child-1" }, route],
  [delegate, delegate],
  [{ kind: "approve", stage: "human-gate" }],
  [{ kind: "shell", command: "request from the work item" }],
])(
  "rejects unknown commands, authority fields and duplicate or unbounded children",
  (...commands) => {
    expect(parseForemanPlan(envelope(...commands))).toMatchObject({
      status: "blocked",
      code: "invalid_plan",
    });
  },
);

it("enforces byte bounds and preserves duplicate-key rejection at the JSON boundary", () => {
  expect(parseForemanPlan("🌍".repeat(7_000))).toEqual({
    status: "blocked",
    code: "plan_too_large",
  });
  expect(
    parseForemanPlan(
      '{"version":1,"version":1,"commands":[{"kind":"read_child","childRef":"child-1"}]}',
    ),
  ).toEqual({
    status: "blocked",
    code: "invalid_plan",
  });
});

it("rejects a combined delegate when its target does not match the proposed route", () => {
  expect(parseForemanPlan(envelope(route, { ...delegate, targetNodeId: "child.second" }))).toEqual({
    status: "blocked",
    code: "inconsistent_target",
  });
});

it.each([
  null,
  { ...stored, rootSessionId: "other-root" },
  { ...stored, routeOccurrenceId: "old-loop-occurrence" },
  { ...stored, resolution: "fallback", selectedDestinationId: "child.second" },
  { ...stored, resolution: "clarification" },
] as const)("does not delegate from a missing, stale or different route receipt", (decision) => {
  expect(
    bindForemanDelegation({
      scope,
      command: delegate,
      decision,
      declaredTargetIds: new Set(["child.first", "child.second"]),
    }),
  ).toMatchObject({ status: "blocked" });
});

it("rejects a target even if it appears in a receipt when it is outside the compiled policy", () => {
  expect(
    bindForemanDelegation({
      scope,
      command: delegate,
      decision: stored,
      declaredTargetIds: new Set(["child.second"]),
    }),
  ).toMatchObject({ status: "blocked" });
});

it("reads only the children offered under the actual parent and root", () => {
  const child = { childSessionId: "actual-child", targetOccurrenceId: stored.targetOccurrenceId };
  const offered = new Map([["child-1", child]]);
  expect(
    parseForemanPlan(envelope(route, { kind: "read_child", childRef: "child-1" })),
  ).toMatchObject({ status: "parsed" });
  expect(bindForemanChildRead({ kind: "read_child", childRef: "child-1" }, offered)).toEqual({
    status: "bound",
    child,
  });
  expect(bindForemanChildRead({ kind: "read_child", childRef: "another-child" }, offered)).toEqual({
    status: "blocked",
    code: "child_unavailable",
  });
});
