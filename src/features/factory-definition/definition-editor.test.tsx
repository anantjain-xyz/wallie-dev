// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { FactoryDefinitionEditor } from "@/features/factory-definition/definition-editor";
import type { CapabilityRepository } from "@/features/settings/sandbox-capability-section";
import type { CandidateSmokeTest } from "@/lib/factory-definitions/candidate-smoke-contracts";
import type {
  FactoryEditorDocument,
  FactoryEditorSnapshot,
} from "@/lib/factory-definitions/editor-contracts";
import {
  FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";
import { mcpManifestScopeIds, type FactoryMcpManifest } from "@/lib/factory-mcp/manifest";
import type { FactorySecretBindingResponse } from "@/lib/factory-secret-bindings/contracts";
import { modelRoutingPolicySchema } from "@/lib/model-routing/contracts";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const endpoint = `/api/workspaces/${id(1)}/factory-definition`;
const credentialsEndpoint = `/api/workspaces/${id(1)}/factories/${id(9)}/secret-bindings`;
const createdAt = "2026-11-15T20:00:00Z";

const source: SerialFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipeline: id(2),
  repository: id(3),
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 3,
    maxTurns: 5,
  },
  executionPolicy: null,
  deliveryPolicy: null,
  skills: [],
  tools: [],
  operatingRulesMd: "",
  stages: [
    {
      id: id(4),
      slug: "plan",
      name: "Plan",
      description: "",
      promptTemplateMd: "Plan the session.",
      anyoneCanApprove: true,
      approverMemberIds: [],
    },
  ],
};

function document(
  number: number,
  kind: FactoryEditorDocument["kind"],
  source: SerialFactoryDefinition,
): FactoryEditorDocument {
  const {
    pipeline,
    repository,
    writableRepositories,
    readContextRepositories,
    executionPolicy,
    executionGrant,
    credentialBindingId,
    implementationAgent,
    deliveryPolicy,
    skills,
    tools,
    stages,
    agent,
    sandboxProvider,
    operatingRulesMd,
    schemaVersion,
    kind: workflowKind,
  } = source;
  return {
    id: id(number),
    kind,
    createdAt,
    digest: number.toString(16).repeat(64),
    sourceDraftId: kind === "revision" ? id(10) : null,
    source,
    bundle: {
      agent,
      sandboxProvider,
      operatingRulesMd,
      ...(schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
        ? { schemaVersion, scorerRevisionIds: source.scorerRevisionIds }
        : { schemaVersion }),
      kind: workflowKind,
      pipelineId: pipeline,
      repositoryId: repository,
      ...(writableRepositories ? { writableRepositoryIds: writableRepositories } : {}),
      ...(readContextRepositories ? { readContextRepositoryIds: readContextRepositories } : {}),
      executionPolicyRevisionId: executionPolicy,
      ...(executionGrant ? { executionGrant } : {}),
      ...(credentialBindingId ? { credentialBindingId } : {}),
      ...(implementationAgent
        ? {
            implementationAgent: {
              agentId: id(30),
              promptRevisionId: implementationAgent,
              promptMd: "Build the approved task.",
              promptSha256: "a".repeat(64),
            },
          }
        : {}),
      deliveryPolicyRevisionId: deliveryPolicy,
      skillIds: skills,
      toolIds: tools,
      operatingRuleStageIds: [],
      stages: stages.map((stage) => ({ ...stage, previousStageIds: [] })),
      ...(source.modelRouting ? { modelRouting: source.modelRouting } : {}),
    },
  };
}

const published = document(5, "revision", source);
const draft = document(6, "draft", source);
const routingPolicyDraft = document(6, "draft", {
  ...source,
  modelRouting: modelRoutingPolicySchema.parse({
    version: 1,
    taskClasses: [{ id: id(70), slug: "plan", name: "Planning" }],
    rules: [
      {
        id: id(71),
        taskClassId: id(70),
        configuration: {
          agentId: id(72),
          definitionRevisionId: id(73),
          experimentId: id(74),
          qualificationId: id(75),
          modelKey: "openai/gpt-5.5",
          harness: "codex",
          workerRuntime: "node",
        },
        constraints: {
          qualityFloorBps: 8_000,
          minResolvedTrials: 5,
          maxMeanCostUsd: null,
          maxLatencyMs: null,
          minConfidenceBps: null,
        },
        onUnavailable: { kind: "escalate" },
      },
    ],
    onUnmatched: { kind: "escalate" },
  }),
});

const reviewedRoutingDraft: FactoryEditorDocument = {
  ...routingPolicyDraft,
  routingDraftEvidence: {
    version: 1,
    experimentId: id(74),
    candidateKey: "a".repeat(64),
    suite: { id: id(78), revisionId: id(79), purpose: "holdout", name: "Delivery suite" },
    scorerRevisionId: id(80),
    scorerName: "Delivery scorer",
    taskClassName: "Planning",
    definitionDigest: draft.digest,
    replayPolicyRevisionId: id(81),
    replayPolicyDigest: "b".repeat(64),
    ruleId: id(71),
    capturedAt: createdAt,
    qualityPassRateBps: 9_000,
    resolvedTrials: 12,
    measuredMeanCostUsd: "0.08",
    constraints: routingPolicyDraft.source.modelRouting!.rules[0].constraints,
    p95WallLatencyMs: null,
    isRecommended: true,
  },
};

it("shows the working draft's routing evidence until a historical revision is selected", async () => {
  setup({
    initialDraft: {
      ...draft,
      routingDraftEvidence: {
        version: 1,
        experimentId: id(77),
        candidateKey: "a".repeat(64),
        suite: { id: id(78), revisionId: id(79), purpose: "holdout", name: "Delivery suite" },
        scorerRevisionId: id(80),
        scorerName: "Delivery scorer",
        taskClassName: "Invoice delivery",
        definitionDigest: draft.digest,
        replayPolicyRevisionId: id(81),
        replayPolicyDigest: "b".repeat(64),
        ruleId: id(82),
        capturedAt: createdAt,
        qualityPassRateBps: 9_000,
        resolvedTrials: 12,
        measuredMeanCostUsd: "0.08",
        constraints: {
          qualityFloorBps: 8_000,
          minResolvedTrials: 5,
          maxMeanCostUsd: null,
          maxLatencyMs: null,
          minConfidenceBps: null,
        },
        p95WallLatencyMs: null,
        isRecommended: true,
      },
    },
  });
  const evidenceHeading = { name: "Routing draft evidence" };
  expect(await screen.findByRole("heading", evidenceHeading)).toBeVisible();
  expect(screen.getByRole("link", { name: "Open exact comparison configuration" })).toHaveAttribute(
    "href",
    expect.stringContaining(`/comparisons/${id(77)}`),
  );

  fireEvent.click(screen.getByRole("button", { name: /Activation #1/ }));
  await screen.findByRole("button", { name: "Roll back to this revision" });
  expect(screen.queryByRole("heading", evidenceHeading)).toBeNull();
});

it("shows the empty MCP configuration for a definition without bindings", async () => {
  setup();
  expect(await screen.findByRole("heading", { name: "MCP tool manifest" })).toBeVisible();
  expect(screen.getByText("Empty MCP manifest. Add bindings in JSON source.")).toBeVisible();
});

it("inspects the exact saved MCP revision and operations with its opaque secret binding", async () => {
  const manifest: FactoryMcpManifest = {
    agentId: id(30),
    servers: [
      {
        serverId: id(70),
        serverSlug: "inventory",
        toolRevisionId: id(71),
        revisionNumber: 3,
        endpoint: "https://approved.example.test/mcp",
        operations: ["read_item"],
        auth: { kind: "bearer", secretBindingId: id(72) },
      },
    ],
  };
  const saved = document(6, "draft", {
    ...source,
    implementationAgent: id(73),
    executionPolicy: id(74),
    executionGrant: { id: id(75), version: 1 },
    mcpBindings: [{ toolRevisionId: id(71), operations: ["read_item"], secretBindingId: id(72) }],
  });
  setup({
    initialDraft: {
      ...saved,
      bundle: {
        ...saved.bundle,
        mcpManifest: manifest,
        toolIds: mcpManifestScopeIds(manifest.servers),
      },
    },
    credentials: { binding: null, availableBinding: null, grantMatches: true, eligibleSecrets: [] },
  });
  const servers = await screen.findByRole("list", { name: "Approved MCP servers" });
  expect(within(servers).getByRole("heading", { name: "inventory · Revision 3" })).toBeVisible();
  expect(within(servers).getByText("read_item")).toBeVisible();
  expect(within(servers).getByText(id(72))).toBeVisible();
  expect(within(servers).queryByRole("link")).toBeNull();
});

const previous = document(7, "revision", {
  ...source,
  sandboxProvider: "e2b",
  operatingRulesMd: "Earlier rule.",
});
const activation = (document: FactoryEditorDocument, number: number) => ({
  id: id(100 + number),
  revisionId: document.id,
  activationNumber: number,
  previousActivationNumber: number === 1 ? null : number - 1,
  createdAt,
});

function receipt(
  doc: FactoryEditorDocument,
  status: CandidateSmokeTest["status"],
  suffix: number,
): CandidateSmokeTest {
  return {
    id: id(suffix),
    target: { kind: doc.kind, id: doc.id },
    definitionDigest: doc.digest,
    baseActivationNumber: 2,
    policyVersion: 1,
    status,
    createdAt,
    finishedAt: status === "running" ? null : createdAt,
    evidence:
      status === "passed"
        ? {
            stageCount: 1,
            completedStageCount: 1,
            stages: [{ stageId: id(4), promptDigest: "b".repeat(64) }],
          }
        : null,
    error: status === "failed" ? "The serial test failed." : null,
  };
}

function setup({
  selection = null,
  initialActivationNumber = 2,
  initialDraftPasses = true,
  initialDraft = draft,
  initialPublished = published,
  repositories = [{ id: id(3), fullName: "acme/project", isArchived: false }],
  credentials,
  routingPreview,
}: {
  selection?: Parameters<typeof FactoryDefinitionEditor>[0]["selection"];
  initialActivationNumber?: number;
  initialDraftPasses?: boolean;
  initialDraft?: FactoryEditorDocument;
  initialPublished?: FactoryEditorDocument;
  repositories?: CapabilityRepository[];
  credentials?: FactorySecretBindingResponse;
  routingPreview?: (body: Record<string, unknown>) => Response;
} = {}) {
  let snapshot: FactoryEditorSnapshot = {
    activationNumber: initialActivationNumber,
    published: initialPublished,
    draft: initialDraft,
    baseline: null,
    readySandboxProviders: ["vercel"],
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const records = new Map(
    [initialPublished, previous, initialDraft].map((document) => [document.id, document]),
  );
  const reads: string[] = [];
  const capabilityReads: string[] = [];
  const executionProfileReads: string[] = [];
  const credentialReads: string[] = [];
  const tests = new Map<string, CandidateSmokeTest[]>([
    [initialDraft.id, initialDraftPasses ? [receipt(initialDraft, "passed", 41)] : []],
    [
      previous.id,
      [{ ...receipt(previous, "passed", 42), baseActivationNumber: initialActivationNumber }],
    ],
  ]);
  let testCount = 50;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, "http://localhost");
    if (pathname === credentialsEndpoint) {
      credentialReads.push(url);
      return Response.json(credentials);
    }
    if (pathname === `${endpoint}/execution-profile`) {
      executionProfileReads.push(url);
      const id = searchParams.get("draftId") ?? searchParams.get("revisionId");
      const candidate = id ? records.get(id) : null;
      if (!candidate) return Response.json({ error: "Definition unavailable." }, { status: 404 });
      const { provider, model, effort } = candidate.bundle.agent;
      return Response.json({
        profile: {
          provider,
          model,
          effort,
          maxTurns: null,
          sandboxProvider: candidate.bundle.sandboxProvider,
          credentialAuthority: { kind: "human", memberId: null },
        },
        readiness: {
          status: "checked",
          credential: { status: "ready" },
          sandbox: {
            status: "unavailable",
            reason: "Run a capability check for the primary repository.",
          },
        },
      });
    }
    if (pathname === `${endpoint}/capability-check`) {
      if (options?.method !== "POST") {
        capabilityReads.push(url);
        return Response.json({ check: null });
      }
      const body = JSON.parse(String(options.body));
      requests.push({ path: pathname, body });
      return Response.json({
        check: {
          checkedAt: createdAt,
          capabilities: {},
          githubRepositoryId: body.repositoryId,
          status: "success",
        },
      });
    }
    if (pathname.startsWith(`${endpoint}/candidate-tests`)) {
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body));
        requests.push({ path: pathname, body });
        const candidate = records.get(body.target.id);
        if (!candidate) throw new Error("Unknown candidate");
        const running = receipt(candidate, "running", testCount++);
        tests.set(candidate.id, [running, ...(tests.get(candidate.id) ?? [])]);
        return Response.json({ test: running }, { status: 202 });
      }
      const testId = pathname.split("/").at(-1);
      const targetId = searchParams.get("targetId") ?? "";
      reads.push(url);
      const matches = (tests.get(targetId) ?? []).filter(
        ({ definitionDigest }) => definitionDigest === searchParams.get("digest"),
      );
      if (testId !== "candidate-tests") {
        return Response.json({ test: matches.find(({ id }) => id === testId) });
      }
      const latest = matches[0];
      const eligible =
        latest?.status === "passed" && latest.baseActivationNumber === snapshot.activationNumber;
      return Response.json({
        tests: matches.map((test) => ({ ...test, evidence: null })),
        eligibility: {
          eligible,
          reason: eligible ? null : "A current passing smoke test is required.",
          activationNumber: snapshot.activationNumber,
        },
      });
    }
    if (options?.method !== "POST") {
      if (pathname === endpoint) {
        const currentActivation = activation(
          snapshot.published ?? published,
          snapshot.activationNumber,
        );
        return Response.json({
          factoryId: id(9),
          currentActivation,
          activations: [currentActivation, activation(previous, 1)],
          nextBeforeActivationNumber: null,
        });
      }
      const selection = searchParams.get("revisionId") ?? searchParams.get("draftId");
      return Response.json(selection ? { document: records.get(selection) } : { snapshot });
    }

    const body = JSON.parse(String(options.body));
    requests.push({ path: pathname, body });
    if (body.expectedActivationNumber !== snapshot.activationNumber) {
      return Response.json({ error: "The activation changed." }, { status: 409 });
    }
    if (pathname === `${endpoint}/routing-preview`) {
      const current = snapshot.draft;
      if (!current || current.id !== body.draftId) {
        return Response.json({ error: "The draft changed." }, { status: 409 });
      }
      return (
        routingPreview?.(body) ??
        Response.json({ draftId: current.id, draftDigest: current.digest, decision: null })
      );
    }
    if (body.action === "rollback") {
      const selected = records.get(body.revisionId);
      if (!selected) throw new Error("Unknown revision");
      snapshot = {
        ...snapshot,
        published: selected,
        draft: null,
        activationNumber: snapshot.activationNumber + 1,
      };
      return Response.json({ activation: { revisionId: selected.id } });
    }
    if (body.action === "publish" || body.action === "activate-routing") {
      if (body.draftId !== snapshot.draft?.id || !snapshot.draft) {
        return Response.json({ error: "The draft changed." }, { status: 409 });
      }
      const next = { ...snapshot.draft, id: id(11), kind: "revision" as const };
      records.set(next.id, next);
      snapshot = {
        ...snapshot,
        published: next,
        draft: null,
        activationNumber: 3,
        ...(body.action === "activate-routing" ? { routingMode: "active" } : {}),
        ...(body.canary
          ? {
              routingCanary: {
                ...body.canary,
                id: id(83),
                activationNumber: 3,
                baselineActivationNumber: 2,
                taskClassSlug: "plan",
                candidateRevisionId: next.id,
                baselineRevisionId: published.id,
                minimumSupport: 5,
                createdAt,
              },
            }
          : {}),
      };
      return body.action === "activate-routing"
        ? Response.json({ activation: activation(next, 3) })
        : Response.json({ snapshot: { activationNumber: 3 } });
    }
    if (body.expectedDraftId !== (snapshot.draft?.id ?? null)) {
      return Response.json({ error: "The draft changed." }, { status: 409 });
    }
    const nextSource =
      body.source.kind === "json" ? JSON.parse(body.source.text) : body.source.value;
    const next = document(8, "draft", nextSource);
    if (pathname.endsWith("/editor")) return Response.json({ content: next });
    snapshot = { ...snapshot, draft: next };
    records.set(next.id, next);
    return Response.json({ draft: { id: next.id } });
  });

  render(
    <FactoryDefinitionEditor
      repositories={repositories}
      selection={selection}
      workspaceId={id(1)}
      workspaceSlug="acme"
    />,
    { wrapper: PortalRootProvider },
  );
  return {
    requests,
    reads,
    capabilityReads,
    executionProfileReads,
    credentialReads,
    completeTest(targetId: string, status: "passed" | "failed") {
      const list = tests.get(targetId);
      const doc = records.get(targetId);
      if (!doc || !list?.[0]) throw new Error("No running test");
      tests.set(targetId, [{ ...receipt(doc, status, 99), id: list[0].id }, ...list.slice(1)]);
      fireEvent(window, new Event("focus"));
    },
    updateReadyProviders(readySandboxProviders: FactoryEditorSnapshot["readySandboxProviders"]) {
      snapshot = { ...snapshot, readySandboxProviders };
    },
    advanceActivation(refresh = true) {
      snapshot = { ...snapshot, activationNumber: snapshot.activationNumber + 1 };
      if (refresh) fireEvent(window, new Event("focus"));
    },
    updateDraft() {
      const next = document(10, "draft", { ...source, operatingRulesMd: "Externally updated." });
      snapshot = { ...snapshot, draft: next };
      records.set(next.id, next);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows credential rotation status and saves only the selected binding reference", async () => {
  const bindingId = id(32);
  const { requests } = setup({
    initialDraft: document(6, "draft", {
      ...source,
      executionGrant: { id: id(28), version: 1 },
      executionPolicy: id(29),
      implementationAgent: id(31),
    }),
    credentials: {
      binding: {
        id: bindingId,
        version: 1,
        status: "ready",
        materialRevision: 3,
        rotatedAt: createdAt,
        secretKey: "FIXTURE_SERVICE_API_KEY",
      },
      availableBinding: null,
      grantMatches: true,
      eligibleSecrets: [],
    },
  });
  expect(await screen.findByText(/Material revision 3/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Use in working definition" }));
  fireEvent.click(screen.getByRole("button", { name: "JSON source" }));
  const json = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Definition JSON" });
  expect(JSON.parse(json.value)).toEqual({
    ...source,
    executionGrant: { id: id(28), version: 1 },
    executionPolicy: id(29),
    implementationAgent: id(31),
    credentialBindingId: bindingId,
  });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved.");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toMatchObject({
    action: "draft",
    source: { kind: "json" },
  });
});

it("uses the upstream provider from the saved OpenCode model for service credentials", async () => {
  const { credentialReads } = setup({
    initialDraft: document(6, "draft", {
      ...source,
      agent: {
        ...source.agent,
        provider: "opencode",
        model: "openrouter/anthropic/claude-sonnet-4",
      },
      executionGrant: { id: id(28), version: 1 },
      executionPolicy: id(29),
      implementationAgent: id(31),
    }),
    credentials: { binding: null, availableBinding: null, grantMatches: true, eligibleSecrets: [] },
  });
  expect(await screen.findByText("openrouter", { exact: true })).toBeVisible();
  await waitFor(() => expect(credentialReads).toHaveLength(1));
  const query = new URL(credentialReads[0] ?? "/", "http://localhost").searchParams;
  expect(query.get("openCodeProviderId")).toBe("openrouter");
});

it("round-trips source edits with scorer pins and publishes the exact saved draft", async () => {
  const { requests, completeTest } = setup();
  const scorerRevisionIds = [id(76)];
  await screen.findByRole("textbox", { name: "Model" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "JSON source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Definition JSON" }), {
    target: {
      value: JSON.stringify({
        ...source,
        schemaVersion: FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
        scorerRevisionIds,
        agent: { ...source.agent, model: "gpt-5.6" },
      }),
    },
  });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Structured" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-5.6"),
  );
  expect(requests[0]).toMatchObject({
    path: `${endpoint}/editor`,
    body: { expectedActivationNumber: 2, expectedDraftId: draft.id, source: { kind: "json" } },
  });

  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved.");
  expect(requests[1]).toMatchObject({
    path: endpoint,
    body: {
      action: "draft",
      source: {
        kind: "structured",
        value: {
          schemaVersion: FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
          scorerRevisionIds,
          agent: { model: "gpt-5.6" },
        },
      },
    },
  });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  const start = await screen.findByRole("button", { name: "Run configuration test" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByRole("button", { name: "Cancel test" });
  expect(requests[2]).toMatchObject({
    body: { target: { kind: "draft", id: id(8) }, expectedDigest: "8".repeat(64) },
  });
  completeTest(id(8), "passed");
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
  await screen.findByText("Draft published for new sessions.");
  expect(requests[3]).toEqual({
    path: `${endpoint}/settings`,
    body: { action: "publish", expectedActivationNumber: 2, draftId: id(8) },
  });
});

it("retains conflicted input and reuses the newest write token only after explicit reapplication", async () => {
  const { requests, updateDraft } = setup();
  const model = await screen.findByRole("textbox", { name: "Model" });
  fireEvent.change(model, { target: { value: "gpt-5.6" } });
  updateDraft();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("The draft changed.");
  expect(model).toHaveValue("gpt-5.6");
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  const apply = await screen.findByRole("button", { name: "Apply edits to latest draft" });
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  expect(model).toHaveValue("gpt-5.6");
  fireEvent.click(apply);
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved.");
  expect(requests[1]?.body).toMatchObject({
    expectedDraftId: id(10),
    source: { value: { agent: { model: "gpt-5.6" } } },
  });
});

it("activates an immutable selected revision using the displayed activation guard", async () => {
  const { requests } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Activation #1/ }));
  const rollback = await screen.findByRole("button", { name: "Roll back to this revision" });
  await waitFor(() => expect(rollback).toBeEnabled());
  fireEvent.click(rollback);
  const confirmation = await screen.findByRole("alertdialog", { name: "Activate this revision?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Activate revision" }));
  await screen.findByText("Selected revision activated for new sessions.");
  expect(requests[0]).toEqual({
    path: endpoint,
    body: {
      action: "rollback",
      expectedActivationNumber: 2,
      revisionId: previous.id,
      targetActivationNumber: 1,
    },
  });
});

it("keeps a proposal rollback link pinned when Settings loads a newer active revision", async () => {
  const { requests } = setup({
    selection: { revision: previous.id, activation: 1, restoreFrom: 2 },
    initialActivationNumber: 3,
  });
  const tests = within(await screen.findByRole("region", { name: "Revision configuration tests" }));
  expect(await screen.findByText(/rollback link is stale/i)).toBeVisible();
  expect(tests.getByRole("button", { name: "Retest configuration" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Roll back to this revision" })).toBeDisabled();
  expect(requests).toHaveLength(0);
});

it("shows stale qualification and disables reviewed activation despite passing smoke", async () => {
  setup({
    initialDraft: {
      ...reviewedRoutingDraft,
      routingQualification: {
        activationNumber: null,
        draftId: reviewedRoutingDraft.id,
        revisionId: null,
        definitionDigest: reviewedRoutingDraft.digest,
        status: "stale",
        reasons: ["scorer_revision_changed"],
        targets: [],
      },
    },
  });
  expect(await screen.findByText("The scoring rubric has a newer revision.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Activate reviewed routing" })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Publish in shadow mode" })).toBeEnabled(),
  );
});

it("identifies the exact baseline activation when only its qualification is stale", async () => {
  setup({
    initialPublished: {
      ...published,
      routingQualification: {
        activationNumber: 2,
        draftId: null,
        revisionId: published.id,
        definitionDigest: published.digest,
        status: "stale",
        reasons: [],
        targets: [],
        baseline: {
          activationNumber: 1,
          revisionId: previous.id,
          status: "stale",
          reasons: ["suite_revision_changed"],
        },
      },
    },
  });
  expect(await screen.findByText("Published routing needs requalification")).toBeVisible();
  expect(screen.getByText("Baseline activation #1")).toBeVisible();
  expect(screen.getByText("The benchmark suite has a newer revision.")).toBeVisible();
});

it("confirms the exact reviewed draft and smoke receipt before activating routing", async () => {
  const { requests } = setup({ initialDraft: reviewedRoutingDraft });
  const activate = await screen.findByRole("button", { name: "Activate reviewed routing" });
  await waitFor(() => expect(activate).toBeEnabled());
  expect(screen.getByRole("button", { name: "Publish in shadow mode" })).toBeEnabled();

  const rules = screen.getByRole("textbox", { name: "Operating rules" });
  fireEvent.change(rules, { target: { value: "Unsaved edit" } });
  expect(activate).toBeDisabled();
  fireEvent.change(rules, { target: { value: source.operatingRulesMd } });
  fireEvent.click(activate);
  const dialog = within(
    await screen.findByRole("alertdialog", { name: "Activate reviewed routing?" }),
  );
  expect(dialog.getByText("#2")).toBeVisible();
  expect(dialog.getByText(reviewedRoutingDraft.digest)).toBeVisible();
  expect(dialog.getByText("Planning · 90% passed · 12 resolved trials")).toBeVisible();
  expect(dialog.getByRole("link", { name: /Exact comparison/ })).toHaveAttribute(
    "href",
    expect.stringContaining(`#frontier-configuration-${"a".repeat(64)}`),
  );
  expect(dialog.getByRole("link", { name: /Passing configuration test/ })).toHaveAttribute(
    "href",
    `/w/acme/settings/factory-definition?draft=${reviewedRoutingDraft.id}&test=${id(41)}#candidate-tests`,
  );
  expect(requests).toHaveLength(0);
  fireEvent.click(dialog.getByRole("button", { name: "Activate routing for new sessions" }));
  await screen.findByText("Reviewed routing activated for new sessions.");
  expect(screen.getByText("Routing active for new sessions")).toBeVisible();
  expect(requests).toEqual([
    {
      path: endpoint,
      body: {
        action: "activate-routing",
        expectedActivationNumber: 2,
        draftId: reviewedRoutingDraft.id,
      },
    },
  ]);
});

it("requires retained benchmark evidence even when a routing draft has a passing smoke test", async () => {
  setup({ initialDraft: routingPolicyDraft });
  expect(await screen.findByRole("button", { name: "Activate reviewed routing" })).toBeDisabled();
  expect(
    screen.getByText("Apply a qualified benchmark finding before activating routing."),
  ).toBeVisible();
});

it("enrolls the exact reviewed class at the confirmed share and links to its outcomes", async () => {
  const { requests } = setup({ initialDraft: reviewedRoutingDraft });
  const activate = await screen.findByRole("button", { name: "Activate reviewed routing" });
  await waitFor(() => expect(activate).toBeEnabled());
  fireEvent.click(activate);
  const dialog = within(
    await screen.findByRole("alertdialog", { name: "Activate reviewed routing?" }),
  );
  expect(dialog.getByRole("radio", { name: "All new sessions" })).toBeChecked();
  fireEvent.click(dialog.getByRole("radio", { name: "Canary rollout" }));
  const confirm = dialog.getByRole("button", { name: "Start routing canary" });
  expect(confirm).toBeDisabled();

  const taskClass = dialog.getByRole("combobox", { name: "Canary task class" });
  fireEvent.click(taskClass);
  const taskClassList = within(dialog.getByRole("listbox", { name: "Canary task class" }));
  expect(taskClassList.getAllByRole("option")).toHaveLength(2);
  const planningOption = taskClassList.getByRole("option", { name: "Planning (plan)" });
  expect(planningOption).toHaveAttribute("data-value", id(70));
  fireEvent.click(planningOption);
  const share = dialog.getByRole("spinbutton", { name: "Candidate share (%)" });
  fireEvent.change(share, { target: { value: "100" } });
  expect(confirm).toBeDisabled();
  fireEvent.change(share, { target: { value: "0.001" } });
  expect(confirm).toBeDisabled();
  fireEvent.change(share, { target: { value: "12.75" } });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);

  await screen.findByText("Routing canary started for new sessions.");
  expect(screen.getByText("Canary active · plan · 12.75% candidate share")).toBeVisible();
  expect(screen.getByRole("link", { name: "View canary outcomes" })).toHaveAttribute(
    "href",
    `/w/acme/analytics?factory=${id(9)}&routingCanary=${id(83)}#routing-canary`,
  );
  expect(requests).toEqual([
    {
      path: endpoint,
      body: {
        action: "activate-routing",
        expectedActivationNumber: 2,
        draftId: reviewedRoutingDraft.id,
        canary: { taskClassId: id(70), candidateBps: 1275 },
      },
    },
  ]);
});

it("keeps canary rollout unavailable when the reviewed class is a later stage", async () => {
  const initialDraft = {
    ...document(6, "draft", {
      ...reviewedRoutingDraft.source,
      stages: [
        { ...source.stages[0], id: id(84), slug: "intake", name: "Intake" },
        ...reviewedRoutingDraft.source.stages,
      ],
    }),
    routingDraftEvidence: reviewedRoutingDraft.routingDraftEvidence,
  };
  setup({ initialDraft });
  const activate = await screen.findByRole("button", { name: "Activate reviewed routing" });
  await waitFor(() => expect(activate).toBeEnabled());
  fireEvent.click(activate);
  const dialog = within(
    await screen.findByRole("alertdialog", { name: "Activate reviewed routing?" }),
  );
  expect(dialog.getByRole("radio", { name: "Canary rollout" })).toBeDisabled();
  expect(
    dialog.getByText(
      "A canary requires a compatible baseline and retained evidence for the first stage’s routing rule.",
    ),
  ).toBeVisible();
  expect(dialog.getByRole("button", { name: "Activate routing for new sessions" })).toBeEnabled();
});

it("blocks another activation from a stale routing review", async () => {
  const { advanceActivation, requests } = setup({ initialDraft: reviewedRoutingDraft });
  const activate = await screen.findByRole("button", { name: "Activate reviewed routing" });
  await waitFor(() => expect(activate).toBeEnabled());
  fireEvent.click(activate);
  const dialog = within(
    await screen.findByRole("alertdialog", { name: "Activate reviewed routing?" }),
  );
  advanceActivation(false);
  const confirm = dialog.getByRole("button", { name: "Activate routing for new sessions" });
  fireEvent.click(confirm);
  expect(await dialog.findByRole("alert")).toHaveTextContent("The activation changed.");
  expect(confirm).toBeDisabled();
  expect(requests).toHaveLength(1);
});

it("explains a newer activation and preserves unsaved input when the reviewer reloads", async () => {
  const { advanceActivation, requests } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /Activation #1/ }));
  const draftTests = within(screen.getByRole("region", { name: "Draft configuration tests" }));
  const revisionTests = within(
    await screen.findByRole("region", { name: "Revision configuration tests" }),
  );
  const publish = screen.getByRole("button", { name: "Publish draft" });
  const rollback = screen.getByRole("button", { name: "Roll back to this revision" });
  const draftRetest = draftTests.getByRole("button", { name: "Retest configuration" });
  const revisionRetest = await revisionTests.findByRole("button", { name: "Retest configuration" });
  await waitFor(() => {
    expect(draftRetest).toBeEnabled();
    expect(revisionRetest).toBeEnabled();
    expect(publish).toBeEnabled();
    expect(rollback).toBeEnabled();
  });

  advanceActivation();

  const reloadHint = /active factory revision changed.*reload the definition/i;
  expect(await draftTests.findByText(reloadHint)).toBeVisible();
  expect(await revisionTests.findByText(reloadHint)).toBeVisible();
  expect(draftRetest).toBeDisabled();
  expect(revisionRetest).toBeDisabled();
  expect(publish).toBeDisabled();
  expect(rollback).toBeDisabled();

  const model = screen.getByRole("textbox", { name: "Model" });
  fireEvent.change(model, { target: { value: "gpt-5.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  expect(await screen.findByRole("button", { name: "Apply edits to latest draft" })).toBeVisible();
  expect(model).toHaveValue("gpt-5.6");
  expect(requests).toHaveLength(0);
});

it("checks readiness for the selected revision's provider and refreshes it with the editor", async () => {
  const { updateReadyProviders } = setup();
  const runCheck = () => screen.getByRole("button", { name: "Run capability check" });
  await screen.findByRole("button", { name: "Run capability check" });
  await waitFor(() => expect(runCheck()).toBeEnabled());

  fireEvent.click(screen.getByRole("button", { name: /Activation #1/ }));
  expect(
    await screen.findByText("Connect a sandbox provider before running a capability check."),
  ).toBeVisible();
  expect(runCheck()).toBeDisabled();

  updateReadyProviders(["vercel", "e2b"]);
  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  await waitFor(() => expect(runCheck()).toBeEnabled());
});

it("loads the execution profile for the selected saved definition and refreshes that target", async () => {
  const { executionProfileReads } = setup();
  const heading = await screen.findByRole("heading", { name: "Effective execution profile" });
  const section = heading.closest("section");
  if (!section) throw new Error("Execution profile section is missing.");
  const profile = within(section);
  expect(await profile.findByText("Vercel Sandbox", { exact: true })).toBeVisible();
  expect(profile.getByText("Run a capability check for the primary repository.")).toBeVisible();
  expect(executionProfileReads).toEqual([`${endpoint}/execution-profile?draftId=${draft.id}`]);

  fireEvent.click(screen.getByRole("button", { name: /Activation #1/ }));
  expect(await profile.findByText("E2B", { exact: true })).toBeVisible();
  expect(executionProfileReads).toContain(
    `${endpoint}/execution-profile?revisionId=${previous.id}`,
  );

  fireEvent.click(screen.getByRole("button", { name: "Reload definition" }));
  await waitFor(() =>
    expect(executionProfileReads.filter((url) => url.endsWith(previous.id))).toHaveLength(2),
  );
});

it("checks the selected writable repository and excludes read-only context", async () => {
  const { capabilityReads, requests } = setup({
    initialDraft: document(6, "draft", {
      ...source,
      writableRepositories: [id(12)],
      readContextRepositories: [id(13)],
    }),
    repositories: [
      { id: id(3), fullName: "acme/project", isArchived: false },
      { id: id(12), fullName: "acme/worker", isArchived: false },
      { id: id(13), fullName: "acme/engineering-docs", isArchived: false },
    ],
  });

  const selection = await screen.findByRole("combobox", { name: "Repository" });
  expect(selection).toHaveTextContent("acme/project");
  fireEvent.click(selection);
  expect(screen.queryByRole("option", { name: "acme/engineering-docs" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "acme/worker" }));
  expect(selection).toHaveTextContent("acme/worker");
  const run = screen.getByRole("button", { name: "Run capability check" });
  await waitFor(() => expect(run).toBeEnabled());
  expect(capabilityReads).toContain(
    `${endpoint}/capability-check?draftId=${draft.id}&repositoryId=${id(12)}`,
  );
  fireEvent.click(run);
  await screen.findByText("Sandbox capability check passed.");
  expect(requests).toContainEqual({
    path: `${endpoint}/capability-check`,
    body: { target: { kind: "draft", id: draft.id }, repositoryId: id(12) },
  });
});

it("defers exact receipt evidence and retains a failed attempt when a retest completes", async () => {
  const { reads, requests, completeTest } = setup({ initialDraftPasses: false });
  const start = await screen.findByRole("button", { name: "Run configuration test" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  fireEvent.click(start);
  await screen.findByRole("button", { name: "Cancel test" });
  expect(requests).toHaveLength(1);
  expect(reads.every((url) => url.includes("/candidate-tests?"))).toBe(true);
  completeTest(draft.id, "failed");
  const retest = await screen.findByRole("button", { name: "Retest configuration" });
  expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  fireEvent.click(retest);
  await screen.findByRole("button", { name: "Cancel test" });
  completeTest(draft.id, "passed");
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled());
  expect(screen.getAllByRole("button", { name: /View evidence for test/ })).toHaveLength(2);
  expect(reads.every((url) => url.includes("/candidate-tests?"))).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: /View evidence for test/ })[0]);
  expect(await screen.findByText("b".repeat(64))).toBeVisible();
  expect(reads).toContain(
    `${endpoint}/candidate-tests/${id(51)}?targetKind=draft&targetId=${draft.id}&digest=${draft.digest}`,
  );
});

it("opens a permalink at a specific saved test receipt and scrolls to it after loading", async () => {
  const originalUrl = window.location.href;
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  window.history.replaceState(null, "", "#candidate-tests");
  try {
    const { reads } = setup({ selection: { draft: draft.id, test: id(41) } });
    expect(await screen.findByText("b".repeat(64))).toBeVisible();
    expect(reads).toContain(
      `${endpoint}/candidate-tests/${id(41)}?targetKind=draft&targetId=${draft.id}&digest=${draft.digest}`,
    );
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(scrollIntoView.mock.instances[0]).toBe(
      window.document.getElementById("candidate-tests"),
    );
  } finally {
    window.history.replaceState(null, "", originalUrl);
    if (originalScroll) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  }
});

it("previews the current saved draft for configured and unmatched slugs", async () => {
  const { requests } = setup({
    routingPreview: ({ taskClassSlug }) =>
      Response.json({
        draftId: draft.id,
        draftDigest: draft.digest,
        decision: {
          version: 1,
          taskClassSlug,
          initialReason: null,
          ...(taskClassSlug === "plan"
            ? {
                disposition: "selected",
                source: "primary",
                reason: "qualified",
                taskClassId: id(70),
                ruleId: id(71),
                configuration: {
                  agentId: id(72),
                  definitionRevisionId: id(73),
                  experimentId: id(74),
                  qualificationId: id(75),
                  modelKey: "openai/gpt-5.5",
                  harness: "codex",
                  workerRuntime: "workerd",
                },
                benchmarkCandidateKey: "a".repeat(64),
              }
            : {
                disposition: "escalated",
                source: null,
                reason: "unmatched_class",
                taskClassId: null,
                ruleId: null,
                configuration: null,
                benchmarkCandidateKey: null,
              }),
        },
      }),
  });
  const panel = within(await screen.findByRole("region", { name: "Routing preview" }));
  const input = panel.getByRole("combobox", { name: "Task class slug" });
  const preview = panel.getByRole("button", { name: "Preview routing" });
  expect(input).toHaveValue("plan");

  fireEvent.click(preview);
  expect(
    await panel.findByRole("heading", { name: "Primary configuration selected" }),
  ).toBeVisible();
  expect(panel.getByText("openai/gpt-5.5")).toBeVisible();
  expect(requests).toContainEqual({
    path: endpoint + "/routing-preview",
    body: { expectedActivationNumber: 2, draftId: draft.id, taskClassSlug: "plan" },
  });

  fireEvent.change(input, { target: { value: "unmatched" } });
  expect(panel.queryByRole("heading", { name: "Primary configuration selected" })).toBeNull();
  fireEvent.click(preview);
  expect(await panel.findByRole("heading", { name: "Escalated" })).toBeVisible();
  expect(panel.getByText("No task class matches this slug.")).toBeVisible();

  fireEvent.change(screen.getByRole("textbox", { name: "Operating rules" }), {
    target: { value: "Unsaved draft edit" },
  });
  expect(preview).toBeDisabled();
  expect(panel.getByText("Save draft changes before previewing routing.")).toBeVisible();
  expect(panel.queryByRole("heading", { name: "Escalated" })).toBeNull();
});

it.each([
  [403, "Workspace admin access is required to preview routing."],
  [409, "The draft or active definition changed. Reload the definition and preview again."],
])("shows an actionable routing preview error for status %s", async (status, message) => {
  setup({ routingPreview: () => Response.json({ error: "Unavailable." }, { status }) });
  const panel = within(await screen.findByRole("region", { name: "Routing preview" }));
  fireEvent.click(panel.getByRole("button", { name: "Preview routing" }));
  expect(await panel.findByRole("alert")).toHaveTextContent(message);
});
