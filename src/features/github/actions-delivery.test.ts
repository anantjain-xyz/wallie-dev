import { describe, expect, it, vi } from "vitest";

import {
  actionsDeliveryObservation,
  actionsDeliveryOperation,
} from "@/lib/factory-delivery-commands/actions-contract";

import { dispatchActionsDelivery, observeActionsDelivery } from "./actions-delivery";
import type { mintActionsDeliveryToken } from "./actions-delivery-auth";

const target = actionsDeliveryOperation.parse({
  workspaceId: "66610000-0000-4000-8000-000000000001",
  factoryId: "66610000-0000-4000-8000-000000000002",
  commandId: "66610000-0000-4000-8000-000000000003",
  runNonce: "66610000-0000-4000-8000-000000000004",
  installationId: 501,
  repositoryNumericId: 601,
  repositoryFullName: "fixture/delivery",
  workflowId: 701,
  workflowPath: ".github/workflows/delivery.yml",
  tag: "delivery/verified",
  inputs: { lane: "verification" },
  sourceRevision: "a".repeat(40),
  environment: "fixture",
});
const observed = actionsDeliveryObservation.parse({
  ...target,
  dispatchStartedAt: "2026-11-23T20:40:00.321+00:00",
  observationId: "66610000-0000-4000-8000-000000000005",
  runId: null,
});
const signal = new AbortController().signal;

const qualifiedWorkflow = [
  "run-name: wallie:${{ inputs.wallie_run_nonce }}",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  ...[
    "wallie_command_id",
    "wallie_source_sha",
    "wallie_environment",
    "wallie_run_nonce",
    "lane",
  ].flatMap((name) => [`      ${name}:`, "        type: string", "        required: true"]),
].join("\n");

function provider(responses: Record<string, unknown> = {}) {
  const file = {
    type: "file",
    path: target.workflowPath,
    encoding: "base64",
    content: Buffer.from(qualifiedWorkflow).toString("base64"),
    size: Buffer.byteLength(qualifiedWorkflow),
  };
  const fixture: Record<string, unknown> = {
    "/repos/fixture/delivery": { id: 601, full_name: target.repositoryFullName },
    "/repos/fixture/delivery/actions/workflows/701": {
      id: 701,
      path: target.workflowPath,
      state: "active",
    },
    "/repos/fixture/delivery/releases/tags/delivery%2Fverified": {
      tag_name: target.tag,
      immutable: true,
      draft: false,
      published_at: "2026-11-23T20:00:00Z",
    },
    "/repos/fixture/delivery/git/ref/tags/delivery/verified": {
      ref: `refs/tags/${target.tag}`,
      object: { type: "commit", sha: target.sourceRevision },
    },
    [`/repos/fixture/delivery/contents/${target.workflowPath}`]: file,
    "/repos/fixture/delivery/actions/workflows/701/dispatches": { workflow_run_id: 801 },
    ...responses,
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    const answer = fixture[url.pathname];
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (answer === undefined) throw new Error(`Unexpected request ${url.pathname}`);
    return Response.json(answer);
  });
  const mintToken = vi.fn<typeof mintActionsDeliveryToken>().mockResolvedValue({
    kind: "granted",
    token: "fixture-token",
    actorLogin: "wallie-test[bot]",
  });
  return { fetcher, mintToken };
}

const dispatchPath = "/repos/fixture/delivery/actions/workflows/701/dispatches";
const runPath = "/repos/fixture/delivery/actions/runs/801";
const workflowRuns = "/repos/fixture/delivery/actions/workflows/701/runs";
const run = {
  id: 801,
  repository: { id: 601 },
  head_repository: { id: 601 },
  workflow_id: target.workflowId,
  head_sha: target.sourceRevision,
  head_branch: target.tag,
  path: `${target.workflowPath}@refs/tags/${target.tag}`,
  run_attempt: 1,
  event: "workflow_dispatch",
  display_title: `wallie:${target.runNonce}`,
  actor: { login: "wallie-test[bot]" },
  created_at: "2026-11-23T20:40:01Z",
  status: "completed",
  conclusion: "success",
};

describe("GitHub Actions guarded delivery", () => {
  it("dispatches the exact numeric workflow and immutable tag once with the approved source metadata", async () => {
    const transport = provider();
    await expect(dispatchActionsDelivery({ ...transport, target, signal })).resolves.toEqual({
      kind: "accepted",
      runId: 801,
    });
    expect(transport.mintToken).toHaveBeenCalledExactlyOnceWith({
      installationId: target.installationId,
      repositoryNumericId: target.repositoryNumericId,
      mode: "dispatch",
      signal,
    });
    const sends = transport.fetcher.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual([
      `https://api.github.com${dispatchPath}`,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({ "x-github-api-version": "2026-03-10" }),
        body: JSON.stringify({
          ref: "refs/tags/delivery/verified",
          inputs: {
            ...target.inputs,
            wallie_command_id: target.commandId,
            wallie_source_sha: target.sourceRevision,
            wallie_environment: target.environment,
            wallie_run_nonce: target.runNonce,
          },
        }),
      }),
    ]);
  });

  it.each([
    [
      "mutable tag",
      {
        "/repos/fixture/delivery/releases/tags/delivery%2Fverified": {
          tag_name: target.tag,
          immutable: false,
        },
      },
      "immutable_tag_required",
    ],
    [
      "moved tag",
      {
        "/repos/fixture/delivery/git/ref/tags/delivery/verified": {
          ref: `refs/tags/${target.tag}`,
          object: { type: "commit", sha: "b".repeat(40) },
        },
      },
      "source_mismatch",
    ],
    [
      "wrong repository",
      { "/repos/fixture/delivery": { id: 999, full_name: target.repositoryFullName } },
      "repository_unavailable",
    ],
    [
      "revoked workflow",
      {
        "/repos/fixture/delivery/actions/workflows/701": {
          id: 701,
          path: target.workflowPath,
          state: "disabled_manually",
        },
      },
      "workflow_unavailable",
    ],
    [
      "missing workflow contract",
      {
        [`/repos/fixture/delivery/contents/${target.workflowPath}`]: new Response(null, {
          status: 404,
        }),
      },
      "workflow_contract_mismatch",
    ],
  ])("blocks %s before any provider POST", async (_description, replacements, reason) => {
    const transport = provider(replacements);
    await expect(dispatchActionsDelivery({ ...transport, target, signal })).resolves.toEqual({
      kind: "rejected",
      reason,
    });
    expect(transport.fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(
      true,
    );
  });

  it("does not resolve the potentially mutable tag before verifying the published release", async () => {
    const transport = provider();
    let releaseAccepted = false;
    const upstream = transport.fetcher.getMockImplementation();
    const fetcher: typeof fetch = async (url, options) => {
      if (!upstream) throw new Error("Fixture transport is unavailable.");
      const path = new URL(String(url)).pathname;
      if (path.includes("/releases/tags/")) {
        await Promise.resolve();
        const response = await upstream(url, options);
        releaseAccepted = true;
        return response;
      }
      if (path.includes("/git/ref/tags/")) expect(releaseAccepted).toBe(true);
      return upstream(url, options);
    };
    await expect(
      dispatchActionsDelivery({ ...transport, fetcher, target, signal }),
    ).resolves.toEqual({
      kind: "accepted",
      runId: 801,
    });
  });

  it("makes no provider requests when live installation permission is revoked", async () => {
    const transport = provider();
    transport.mintToken.mockResolvedValue({ kind: "blocked", reason: "permission_missing" });
    await expect(dispatchActionsDelivery({ ...transport, target, signal })).resolves.toEqual({
      kind: "rejected",
      reason: "permission_missing",
    });
    expect(transport.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    new Error("response lost"),
    new Response(null, { status: 502 }),
    new Response(null, { status: 204 }),
    { id: 801 },
  ])("retains unknown provider results after one POST", async (replacement) => {
    const transport = provider({ [dispatchPath]: replacement });
    await expect(dispatchActionsDelivery({ ...transport, target, signal })).resolves.toEqual({
      kind: "unknown",
    });
    expect(
      transport.fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });

  it("recovers a lost response using one exact read-only run observation", async () => {
    const transport = provider({ [workflowRuns]: { total_count: 1, workflow_runs: [run] } });
    await expect(
      observeActionsDelivery({ ...transport, target: observed, signal }),
    ).resolves.toEqual({
      kind: "observed",
      runId: 801,
      status: "completed",
      conclusion: "success",
    });
    expect(transport.fetcher).toHaveBeenCalledTimes(1);
    expect(transport.fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "GET" }),
    );
    const url = new URL(String(transport.fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get("head_sha")).toBe(target.sourceRevision);
  });

  it("correlates GitHub's bare workflow path when its tag and every other run coordinate match", async () => {
    const barePath = { ...run, path: target.workflowPath };
    const transport = provider({ [workflowRuns]: { total_count: 1, workflow_runs: [barePath] } });
    await expect(
      observeActionsDelivery({ ...transport, target: observed, signal }),
    ).resolves.toEqual({
      kind: "observed",
      runId: 801,
      status: "completed",
      conclusion: "success",
    });
    const wrongTag = { ...barePath, head_branch: "main" };
    const changed = provider({ [workflowRuns]: { total_count: 1, workflow_runs: [wrongTag] } });
    await expect(observeActionsDelivery({ ...changed, target: observed, signal })).resolves.toEqual(
      {
        kind: "unverified",
        reason: "run_mismatch",
      },
    );
  });

  it.each([
    ["no match", [run], 0, "run_mismatch"],
    ["truncated list", [run], 26, "run_mismatch"],
    ["multiple matches", [run, { ...run, id: 802 }], 2, "run_mismatch"],
    ["wrong actor", [{ ...run, actor: { login: "repository-operator" } }], 1, "run_mismatch"],
    ["wrong SHA", [{ ...run, head_sha: "b".repeat(40) }], 1, "run_mismatch"],
    ["rerun", [{ ...run, run_attempt: 2 }], 1, "run_mismatch"],
    ["wrong ref", [{ ...run, head_branch: "main" }], 1, "run_mismatch"],
    ["no observed run", [], 0, "run_unavailable"],
  ])("fails closed for %s", async (_description, workflow_runs, total_count, reason) => {
    const transport = provider({ [workflowRuns]: { total_count, workflow_runs } });
    await expect(
      observeActionsDelivery({ ...transport, target: observed, signal }),
    ).resolves.toEqual({
      kind: "unverified",
      reason,
    });
  });

  it("checks only the provider-assigned run identity if it already has a durable receipt", async () => {
    const transport = provider({ [runPath]: { ...run, id: 999 } });
    await expect(
      observeActionsDelivery({ ...transport, target: { ...observed, runId: 801 }, signal }),
    ).resolves.toEqual({
      kind: "unverified",
      reason: "run_mismatch",
    });
    expect(transport.fetcher).toHaveBeenCalledTimes(1);
    expect(String(transport.fetcher.mock.calls[0]?.[0])).toBe(`https://api.github.com${runPath}`);
  });
});
