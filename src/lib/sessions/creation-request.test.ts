import { describe, expect, it } from "vitest";

import { fingerprintSessionCreation } from "./creation-request";

const input = { promptMd: "Build a search box.", workspaceId: "workspace-1" };

describe("session creation fingerprint", () => {
  it("normalizes input and excludes the request identity", () => {
    expect(fingerprintSessionCreation(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fingerprintSessionCreation({
        ...input,
        requestId: "another-request",
        promptMd: ` ${input.promptMd} `,
        attachmentIds: [],
        draftSpecification: false,
      }),
    ).toBe(fingerprintSessionCreation(input));
  });

  it.each([
    { promptMd: "Different work" },
    { title: "Explicit title" },
    { draftSpecification: true },
    { workspaceId: "another-workspace" },
    { githubRepositoryId: "another-repository" },
    { selectedStageIds: ["stage-1"] },
    { attachmentIds: ["image-1"] },
    { restartOfSessionId: "deadbeef-5555-4555-8555-555555555555" },
    { linearIssueUrl: "https://linear.app/acme/issue/ABC-123/example" },
  ])("distinguishes changed user intent: %j", (change) => {
    expect(fingerprintSessionCreation({ ...input, ...change })).not.toBe(
      fingerprintSessionCreation(input),
    );
  });

  it("binds a routing override and its reason to the immutable request", () => {
    const routingOverride = {
      expectedActivationNumber: 4,
      ruleId: "deadbeef-5555-4555-8555-555555555555",
      target: "primary",
      reason: "Use the reviewed primary.",
    } as const;
    const confirmed = { ...input, factoryDefinitionDigest: "a".repeat(64) };
    const fingerprint = fingerprintSessionCreation({ ...confirmed, routingOverride });
    expect(fingerprint).not.toBe(fingerprintSessionCreation(confirmed));
    expect(
      fingerprintSessionCreation({
        ...confirmed,
        routingOverride: { ...routingOverride, reason: `   ${routingOverride.reason} ` },
      }),
    ).toBe(fingerprint);
    expect(
      fingerprintSessionCreation({
        ...confirmed,
        routingOverride: { ...routingOverride, reason: "Verify a changed expectation." },
      }),
    ).not.toBe(fingerprint);
  });

  it("fingerprints the selected exact workflow activation without changing unselected intent", () => {
    const workflowSelection = {
      workflowId: "deadbeef-5555-4555-8555-555555555555",
      activationId: "deadbeef-5555-4555-8555-555555555556",
    };
    const selected = fingerprintSessionCreation({ ...input, workflowSelection });
    expect(selected).not.toBe(fingerprintSessionCreation(input));
    expect(fingerprintSessionCreation({ ...input, workflowSelection: undefined })).toBe(
      fingerprintSessionCreation(input),
    );
    expect(
      fingerprintSessionCreation({
        ...input,
        workflowSelection: {
          workflowId: workflowSelection.workflowId.toUpperCase(),
          activationId: workflowSelection.activationId.toUpperCase(),
        },
      }),
    ).toBe(selected);
    expect(
      fingerprintSessionCreation({
        ...input,
        workflowSelection: { ...workflowSelection, activationId: workflowSelection.workflowId },
      }),
    ).not.toBe(selected);
  });
});
