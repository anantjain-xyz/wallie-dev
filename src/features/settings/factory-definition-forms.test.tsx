// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { SettingsPageData } from "@/features/settings/data";
import { DeliveryPolicySection } from "@/features/settings/delivery-policy-section";
import { FactoryDefinitionIsland } from "@/features/settings/islands/factory-definition-island";
import {
  RuntimeIntegrationIsland,
  VercelIntegrationIsland,
} from "@/features/settings/islands/integration-islands";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { SettingsFactoryDefinitionState } from "@/lib/factory-definitions/settings-contracts";
import { projectSettingsDataWithFactoryDefinition } from "@/lib/factory-definitions/settings-projection";

const workspaceId = "54500000-0002-4000-8000-000000000001";
const factoryId = "54500000-0002-4000-8000-000000000002";
const pipelineId = "54500000-0002-4000-8000-000000000003";
const repositoryId = "54500000-0002-4000-8000-000000000004";
const stageId = "54500000-0002-4000-8000-000000000005";
const memberId = "54500000-0002-4000-8000-000000000006";
const executionPolicyId = "54500000-0002-4000-8000-000000000007";
const deliveryPolicyId = "54500000-0002-4000-8000-000000000008";
const revisionId = "54500000-0002-4000-8000-000000000009";
const draftId = "54500000-0002-4000-8000-000000000010";
const now = "2026-11-15T20:00:00.000Z";

function makeDefinition(
  overrides: Partial<CompiledFactoryDefinition> = {},
): CompiledFactoryDefinition {
  return {
    schemaVersion: 1,
    kind: "serial",
    pipelineId,
    repositoryId,
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      concurrencyLimit: 1,
      stallTimeoutMs: 900_000,
      maxRetries: 3,
      maxTurns: 5,
    },
    executionPolicyRevisionId: executionPolicyId,
    deliveryPolicyRevisionId: deliveryPolicyId,
    skillIds: [],
    toolIds: [],
    operatingRulesMd: "Keep diffs small.",
    operatingRuleStageIds: [],
    stages: [
      {
        id: stageId,
        slug: "plan",
        name: "Plan",
        description: "Plan work",
        promptTemplateMd: "Plan {{session.prompt}}.",
        anyoneCanApprove: false,
        approverMemberIds: [memberId],
        previousStageIds: [],
      },
    ],
    ...overrides,
  };
}

function makeFactoryState(
  overrides: Partial<SettingsFactoryDefinitionState> = {},
): SettingsFactoryDefinitionState {
  const publishedDef = makeDefinition();
  return {
    factoryId,
    expectedActivationNumber: 1,
    currentActivation: {
      id: "activation-1",
      revisionId,
      activationNumber: 1,
      previousActivationNumber: null,
      canonicalDigest: "1a2b3c4d".repeat(8),
      createdAt: now,
      definition: publishedDef,
    },
    latestDraft: null,
    activeDefinition: publishedDef,
    defaultRepositoryId: repositoryId,
    executionPolicy: {
      id: executionPolicyId,
      workspaceId,
      revision: 1,
      createdAt: now,
      requirements: {
        version: 1,
        maxRepairAttempts: 3,
        maxExecutionMs: 3_600_000,
        maxTotalTokens: null,
        maxCostUsd: null,
      },
    },
    deliveryPolicy: {
      id: deliveryPolicyId,
      workspaceId,
      pipelineId,
      revision: 1,
      createdAt: now,
      requirements: {
        version: 1,
        deliveryMode: "code",
        requiredChecks: ["test"],
        minimumApprovals: 1,
        requireCodeOwnerReview: false,
        requireResolvedThreads: true,
        requiredEvidence: [],
        freshnessSeconds: 3600,
        requireArtifactApprovalForDelivery: false,
      },
    },
    liveExecutionPolicyRevision: 1,
    liveDeliveryPolicyRevision: 1,
    ...overrides,
  };
}

function makeSettingsData(
  factoryOverrides: Partial<SettingsFactoryDefinitionState> = {},
): SettingsPageData {
  const factoryDefinition = makeFactoryState(factoryOverrides);
  const vercelConnection = {
    connectionRevision: "rev-vercel",
    lastValidatedAt: now,
    lastValidationError: null,
    projectId: "prj_123",
    projectName: "wallie-sandboxes",
    status: "connected" as const,
    teamId: "team_123",
    tokenPreview: "vca_…1234",
    updatedAt: now,
    workspaceId,
  };
  const e2bConnection = {
    apiKeyPreview: "e2b_…1234",
    connectionRevision: "rev-e2b",
    lastValidatedAt: now,
    lastValidationError: null,
    status: "connected" as const,
    updatedAt: now,
    workspaceId,
  };

  const base: SettingsPageData = {
    agentConfig: {
      agent_provider: "codex",
      agent_model: "gpt-5.6-sol",
      agent_effort: "xhigh",
      concurrency_limit: 1,
      stall_timeout_ms: 900_000,
      max_retries: 3,
      max_turns: 5,
    },
    canManage: true,
    currentMember: { id: memberId, role: "owner" },
    factoryDefinition,
    github: {
      installation: null,
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [],
    },
    latestSandboxCapabilityCheck: null,
    linearRouting: {
      autoStart: false,
      defaultStageSlug: null,
      landStageSlug: null,
      reworkStageSlug: null,
      statusMappings: [],
    } as unknown as SettingsPageData["linearRouting"],
    linearSecret: null,
    onboarding: {
      completedAt: now,
      completedSteps: [],
      createdAt: now,
      currentStep: "verify",
      dismissedAt: null,
      id: "onboarding-1",
      selectedGithubRepositoryId: repositoryId,
      skippedSteps: [],
      status: "completed",
      updatedAt: now,
      workspaceId,
    },
    pipeline: {
      id: pipelineId,
      isDefault: true,
      name: "Default",
      operatingRulesMd: "Keep diffs small.",
      archivedStages: [],
      stages: [
        {
          id: stageId,
          pipelineId,
          position: 1,
          slug: "plan",
          name: "Plan",
          description: "Plan work",
          promptTemplateMd: "Plan {{session.prompt}}.",
          anyoneCanApprove: false,
          approverMemberIds: [memberId],
        },
      ],
    },
    rateLimits: [],
    sandboxSettings: {
      activeProvider: "vercel",
      connections: { daytona: null, e2b: e2bConnection, vercel: vercelConnection },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 1,
      updatedAt: now,
    },
    setupHealth: {
      agentConfig: { configured: true, configuredKeys: [], status: "present", values: {} },
      claudeCodeConnection: {
        checkedAt: now,
        connected: false,
        status: "missing",
        updatedAt: null,
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: now,
        connected: true,
        credentialType: "platform_api_key",
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "connected",
        updatedAt: now,
      },
      defaultPipeline: { configured: true, pipelineId, stageCount: 1, status: "ready" },
      githubInstallation: {
        connected: true,
        installationId: 123,
        status: "present",
        suspended: false,
        targetName: "acme",
        updatedAt: now,
      },
      latestSandboxCapabilityCheck: null,
      linearKey: { configured: false, status: "missing", updatedAt: null },
      linearRouting: { configured: false, status: "missing", updatedAt: null },
      openCodeConnection: {
        checkedAt: now,
        connected: false,
        providers: [],
        status: "missing",
        updatedAt: null,
      },
      primaryRepositoryProfile: {
        configured: true,
        fullName: "acme/app",
        repositoryId,
        status: "ready",
      },
      repositorySetup: { configured: true, repositoryId, status: "ready" },
      selectedRepository: { configured: true, fullName: "acme/app", repositoryId, status: "ready" },
      sandboxConnection: {
        connected: true,
        connectionRevision: "rev-vercel",
        displayName: "wallie-sandboxes",
        lastValidationError: null,
        provider: "vercel",
        providerLabel: "Vercel Sandbox",
        status: "connected",
        updatedAt: now,
      },
      vercelSandboxConnection: {
        connected: true,
        lastValidationError: null,
        projectId: "prj_123",
        projectName: "wallie-sandboxes",
        status: "connected",
        teamId: "team_123",
        updatedAt: now,
      },
      workspaceSecrets: { configuredKeys: [] },
    },
    usage: {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRuns: 0,
      tokensUnavailable: false,
      costUnavailable: false,
      hasEstimatedTokens: false,
      hasEstimatedCost: false,
    },
    vercelSandboxConnection: vercelConnection,
    workspace: { avatarPath: null, avatarUrl: null, id: workspaceId, name: "Acme", slug: "acme" },
    workspaceInvitations: [],
    workspaceMembers: [
      {
        avatarUrl: null,
        email: "owner@example.com",
        fullName: "Avery Owner",
        id: memberId,
        role: "owner",
      },
    ],
    workspaceSecrets: [],
  };

  return projectSettingsDataWithFactoryDefinition(base, factoryDefinition);
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings shared factory definition forms", () => {
  it("routes AgentConfigSection through shared drafts, updates FactoryDefinitionIsland, and publishes", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    const draftDef = makeDefinition({
      agent: {
        ...initialData.factoryDefinition!.activeDefinition!.agent,
        model: "gpt-5.6",
      },
    });
    const draftState = makeFactoryState({
      latestDraft: {
        id: draftId,
        baseActivationNumber: 1,
        schemaVersion: 1,
        canonicalDigest: "9e8d7c6b".repeat(8),
        createdAt: now,
        definition: draftDef,
      },
      activeDefinition: draftDef,
    });
    const publishedState = makeFactoryState({
      expectedActivationNumber: 2,
      currentActivation: {
        id: "activation-2",
        revisionId: "54500000-0002-4000-8000-000000000099",
        activationNumber: 2,
        previousActivationNumber: 1,
        canonicalDigest: "9e8d7c6b".repeat(8),
        createdAt: now,
        definition: draftDef,
      },
      latestDraft: null,
      activeDefinition: draftDef,
    });

    let callIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/codex/connection") {
        return Response.json({ connected: true, checkedAt: now });
      }
      callIndex += 1;
      if (callIndex === 1) {
        return Response.json(
          {
            state: draftState,
            agentConfig: {
              ...initialData.agentConfig,
              agent_model: "gpt-5.6",
            },
          },
          { status: 201 },
        );
      }
      void init;
      return Response.json(
        {
          state: publishedState,
          activation: {
            id: "activation-2",
            revisionId: "54500000-0002-4000-8000-000000000099",
            activationNumber: 2,
            previousActivationNumber: 1,
            createdAt: now,
          },
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <OverlayProvider>
        <main>
          <FactoryDefinitionIsland initialData={initialData} />
          <RuntimeIntegrationIsland codexStatus={null} initialData={initialData} />
        </main>
      </OverlayProvider>,
    );

    const banner = screen.getByRole("region", { name: "Factory definition" });
    expect(within(banner).getByText("Published #1")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Publish draft" })).toBeDisabled();

    const modelInput = screen.getByLabelText("Model");
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-5.6");

    // Unsaved identity should appear in the shared FactoryDefinitionIsland
    expect(within(banner).getByText("Unsaved edits")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save draft" }));

    const settingsCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/factory-definition/settings"));
    await waitFor(() => expect(settingsCalls()).toHaveLength(1));
    expect(JSON.parse(String(settingsCalls()[0]?.[1]?.body))).toEqual({
      action: "draft",
      expectedActivationNumber: 1,
      expectedDraftId: null,
      patch: {
        kind: "agent",
        agent: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.6",
        }),
      },
    });

    // Draft identity appears and Publish draft becomes enabled
    expect(await within(banner).findByText("Draft saved")).toBeInTheDocument();
    const publishButton = within(banner).getByRole("button", { name: "Publish draft" });
    expect(publishButton).toBeEnabled();

    await user.click(publishButton);
    await waitFor(() => expect(settingsCalls()).toHaveLength(2));
    expect(JSON.parse(String(settingsCalls()[1]?.[1]?.body))).toEqual({
      action: "publish",
      expectedActivationNumber: 1,
      draftId,
    });
    expect(await within(banner).findByText("Published #2")).toBeInTheDocument();
    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toHaveProperty("violations", []);
  });

  it("retains user input and maps 422 compiler diagnostics in AgentConfigSection", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/codex/connection") {
        return Response.json({ connected: true, checkedAt: now });
      }
      return Response.json(
        {
          error: "Review the factory definition before retrying.",
          diagnostics: [
            {
              path: ["agent", "model"],
              code: "unsupported_capability",
              message: 'Choose a model supported by "codex".',
            },
          ],
          fieldErrors: {
            agent_model: 'Choose a model supported by "codex".',
          },
        },
        { status: 422 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OverlayProvider>
        <RuntimeIntegrationIsland codexStatus={null} initialData={initialData} />
      </OverlayProvider>,
    );

    const modelInput = screen.getByLabelText("Model");
    await user.clear(modelInput);
    await user.type(modelInput, "claude-opus-4-8");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    const matches = await screen.findAllByText('Choose a model supported by "codex".');
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(modelInput).toHaveValue("claude-opus-4-8");
  });

  it("retains edited pipeline inputs on 409 conflict and recovers via Reload saved definition", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    const reloadedDef = makeDefinition({ operatingRulesMd: "Server updated rules." });
    const reloadedState = makeFactoryState({
      expectedActivationNumber: 2,
      currentActivation: {
        id: "activation-2",
        revisionId: "54500000-0002-4000-8000-000000000099",
        activationNumber: 2,
        previousActivationNumber: 1,
        canonicalDigest: "bbbbbbbb".repeat(8),
        createdAt: now,
        definition: reloadedDef,
      },
      activeDefinition: reloadedDef,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "The active factory definition changed. Reload before retrying." },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          state: reloadedState,
          pipeline: {
            ...initialData.pipeline!,
            operatingRulesMd: "Server updated rules.",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OverlayProvider>
        <PipelineEditor
          canManage
          factoryDefinition={initialData.factoryDefinition}
          pipeline={initialData.pipeline}
          workspaceId={workspaceId}
          workspaceMembers={initialData.workspaceMembers}
        />
      </OverlayProvider>,
    );

    const rulesInput = screen.getByLabelText("Operating rules");
    await user.clear(rulesInput);
    await user.type(rulesInput, "My local draft rules.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((el) =>
            el.textContent?.includes(
              "The active factory definition changed. Reload before retrying.",
            ),
          ),
      ).toBe(true),
    );
    // Retains user input for review
    expect(rulesInput).toHaveValue("My local draft rules.");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reload saved definition" }));
    await waitFor(() => expect(rulesInput).toHaveValue("Server updated rules."));
  });

  it("retains ExecutionPolicy and DeliveryPolicy edits on 409 conflict without mount GETs", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    const reloadedState = makeFactoryState({
      expectedActivationNumber: 2,
      executionPolicy: {
        ...initialData.factoryDefinition!.executionPolicy!,
        revision: 2,
        requirements: {
          ...initialData.factoryDefinition!.executionPolicy!.requirements,
          maxRepairAttempts: 1,
        },
      },
      deliveryPolicy: {
        ...initialData.factoryDefinition!.deliveryPolicy!,
        revision: 2,
        requirements: {
          ...initialData.factoryDefinition!.deliveryPolicy!.requirements,
          requiredChecks: ["lint", "test"],
        },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/codex/connection") {
        return Response.json({ connected: true, checkedAt: now });
      }
      if (init?.method === "POST") {
        return Response.json(
          { error: "The execution policy changed. Reload before retrying." },
          { status: 409 },
        );
      }
      return Response.json({
        state: reloadedState,
        pipeline: initialData.pipeline,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OverlayProvider>
        <RuntimeIntegrationIsland codexStatus={null} initialData={initialData} />
        <DeliveryPolicySection
          canManage
          factoryDefinition={initialData.factoryDefinition}
          pipelineId={pipelineId}
          workspaceId={workspaceId}
        />
      </OverlayProvider>,
    );

    // Zero mount GET fetches for execution-policy or delivery-policy because server preloaded them
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("policy"))).toHaveLength(0);

    const repairsInput = screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ });
    fireEvent.change(repairsInput, { target: { value: "8" } });
    await user.click(screen.getAllByRole("button", { name: "Save policy draft" })[0]!);

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((el) =>
            el.textContent?.includes("The execution policy changed. Reload before retrying."),
          ),
      ).toBe(true),
    );
    expect(repairsInput).toHaveValue(8);
    expect(screen.getAllByRole("button", { name: "Save policy draft" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Save policy draft" })[1]).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: "Reload saved definition" })[0]!);
    await waitFor(() => expect(repairsInput).toHaveValue(1));
    expect(screen.getByRole("textbox", { name: /^Required GitHub checks/ })).toHaveValue(
      "lint\ntest",
    );
  });

  it("routes SandboxProviderSection provider activation through drafts while keeping credential operations immediate", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    const draftDef = makeDefinition({ sandboxProvider: "e2b" });
    const draftState = makeFactoryState({
      latestDraft: {
        id: draftId,
        baseActivationNumber: 1,
        schemaVersion: 1,
        canonicalDigest: "77777777".repeat(8),
        createdAt: now,
        definition: draftDef,
      },
      activeDefinition: draftDef,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ state: draftState, sandboxProvider: "e2b" }, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          connection: {
            ...initialData.sandboxSettings.connections.e2b!,
            apiKeyPreview: "e2b_…9999",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OverlayProvider>
        <VercelIntegrationIsland initialData={initialData} />
      </OverlayProvider>,
    );

    await user.click(screen.getByRole("radio", { name: /E2B/ }));
    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/workspaces/${workspaceId}/factory-definition/settings`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "draft",
      expectedActivationNumber: 1,
      expectedDraftId: null,
      patch: { kind: "sandbox-provider", sandboxProvider: "e2b" },
    });

    // Credential rotation remains immediate via /sandbox-connections/e2b
    await user.click(screen.getByRole("button", { name: "Replace connection" }));
    await user.type(screen.getByLabelText("API key"), "e2b_new_secret_key");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/workspaces/${workspaceId}/sandbox-connections/e2b`,
    );
  });

  it("targets the published factory revision for capability checks when no draft exists", async () => {
    const user = userEvent.setup();
    const initialData = makeSettingsData();
    initialData.github.repositories = [
      {
        archived: false,
        defaultBranch: "main",
        fullName: "acme/app",
        htmlUrl: "https://github.com/acme/app",
        id: repositoryId,
        isArchived: false,
        name: "app",
        private: true,
        repoId: 101,
      } as unknown as SettingsPageData["github"]["repositories"][number],
    ];

    const runningCheck = {
      agentModel: "gpt-5.6-sol",
      agentProvider: "codex",
      capabilities: {},
      checkedAt: now,
      errorText: null,
      githubRepositoryId: repositoryId,
      id: "check-1",
      sandboxConnectionRevision: "rev-vercel",
      sandboxProvider: "vercel",
      status: "running",
    };
    const passedCheck = {
      ...runningCheck,
      status: "success",
      capabilities: { git: { ok: true, detail: null } },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ check: runningCheck }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ check: passedCheck }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <OverlayProvider>
          <VerifySetupSection data={initialData} setData={vi.fn()} setFlashMessage={vi.fn()} />
        </OverlayProvider>,
      );

      await user.click(screen.getByRole("button", { name: "Run capability check" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `/api/workspaces/${workspaceId}/factory-definition/capability-check`,
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        target: { kind: "revision", id: revisionId },
      });

      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        `/api/workspaces/${workspaceId}/factory-definition/capability-check?revisionId=${revisionId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues polling a restored running definition check instead of the legacy endpoint", async () => {
    const initialData = makeSettingsData();
    const runningCheck = {
      agentModel: "gpt-5.6-sol",
      agentProvider: "codex",
      capabilities: {},
      checkedAt: now,
      errorText: null,
      githubRepositoryId: repositoryId,
      id: "check-restored",
      sandboxConnectionRevision: "rev-vercel",
      sandboxProvider: "vercel" as const,
      sandboxVercelProjectId: "prj_123",
      sandboxVercelTeamId: "team_123",
      status: "running" as const,
    };
    const initialWithCheck = {
      ...initialData,
      latestSandboxCapabilityCheck: runningCheck,
      setupHealth: { ...initialData.setupHealth, latestSandboxCapabilityCheck: runningCheck },
      github: {
        ...initialData.github,
        repositories: [
          {
            fullName: "acme/app",
            id: repositoryId,
            isArchived: false,
          } as unknown as SettingsPageData["github"]["repositories"][number],
        ],
      },
    };

    const passedCheck = {
      ...runningCheck,
      capabilities: { git: { ok: true, detail: null } },
      status: "success" as const,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ check: passedCheck }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <OverlayProvider>
          <VerifySetupSection data={initialWithCheck} setData={vi.fn()} setFlashMessage={vi.fn()} />
        </OverlayProvider>,
      );

      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `/api/workspaces/${workspaceId}/factory-definition/capability-check?revisionId=${revisionId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling the original check target when a new draft is saved mid-check", async () => {
    const initialDef = makeDefinition();
    const runningCheck = {
      agentModel: "gpt-5.6-sol",
      agentProvider: "codex",
      capabilities: {},
      checkedAt: now,
      errorText: null,
      githubRepositoryId: repositoryId,
      id: "check-running",
      sandboxConnectionRevision: "rev-vercel",
      sandboxProvider: "vercel" as const,
      sandboxVercelProjectId: "prj_123",
      sandboxVercelTeamId: "team_123",
      status: "running" as const,
    };
    const baseData = makeSettingsData({
      latestDraft: {
        id: draftId,
        baseActivationNumber: 1,
        schemaVersion: 1,
        canonicalDigest: "9e8d7c6b".repeat(8),
        createdAt: now,
        definition: initialDef,
      },
      activeDefinition: initialDef,
    });
    const dataWithCheck = {
      ...baseData,
      latestSandboxCapabilityCheck: runningCheck,
      setupHealth: { ...baseData.setupHealth, latestSandboxCapabilityCheck: runningCheck },
      github: {
        ...baseData.github,
        repositories: [
          {
            fullName: "acme/app",
            id: repositoryId,
            isArchived: false,
          } as unknown as SettingsPageData["github"]["repositories"][number],
        ],
      },
    };
    const nextDraftId = "54500000-0002-4000-8000-0000000000ff";
    const nextData = makeSettingsData({
      latestDraft: {
        id: nextDraftId,
        baseActivationNumber: 1,
        schemaVersion: 1,
        canonicalDigest: "8f7e6d5c".repeat(8),
        createdAt: now,
        definition: makeDefinition({ operatingRulesMd: "Newer draft." }),
      },
      activeDefinition: makeDefinition({ operatingRulesMd: "Newer draft." }),
    });
    const passedCheck = {
      ...runningCheck,
      capabilities: { git: { ok: true, detail: null } },
      status: "success" as const,
    };

    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ check: passedCheck }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(
        <OverlayProvider>
          <VerifySetupSection data={dataWithCheck} setData={vi.fn()} setFlashMessage={vi.fn()} />
        </OverlayProvider>,
      );

      rerender(
        <OverlayProvider>
          <VerifySetupSection
            data={{ ...nextData, github: dataWithCheck.github }}
            setData={vi.fn()}
            setFlashMessage={vi.fn()}
          />
        </OverlayProvider>,
      );

      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `/api/workspaces/${workspaceId}/factory-definition/capability-check?draftId=${draftId}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears busy state and surfaces errors when publish or reload fetch rejects", async () => {
    const user = userEvent.setup();
    const draftDef = makeDefinition();
    const initialData = makeSettingsData({
      latestDraft: {
        id: draftId,
        baseActivationNumber: 1,
        schemaVersion: 1,
        canonicalDigest: "9e8d7c6b".repeat(8),
        createdAt: now,
        definition: draftDef,
      },
      activeDefinition: draftDef,
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error("Network offline"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OverlayProvider>
        <FactoryDefinitionIsland initialData={initialData} />
      </OverlayProvider>,
    );

    const publishButton = screen.getByRole("button", { name: "Publish draft" });
    const reloadButton = screen.getByRole("button", { name: "Reload" });

    await user.click(publishButton);
    expect(await screen.findByText("Network offline")).toBeInTheDocument();
    expect(publishButton).toBeEnabled();
    expect(reloadButton).toBeEnabled();

    await user.click(reloadButton);
    expect(await screen.findByText("Network offline")).toBeInTheDocument();
    expect(publishButton).toBeEnabled();
    expect(reloadButton).toBeEnabled();
  });
});
