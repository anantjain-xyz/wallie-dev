import type { AgentEffort, AgentProvider } from "@/lib/agent-config/contracts";
import type { DeliveryPolicy, DeliveryRequirements } from "@/lib/delivery-policy/contracts";
import type { ExecutionPolicy, ExecutionRequirements } from "@/lib/execution-policy/contracts";
import type {
  CompiledFactoryDefinition,
  FactoryDefinitionDiagnostic,
} from "@/lib/factory-definitions/compiler";
import type { SandboxProvider } from "@/lib/sandbox/types";

export type SettingsFactoryActivationSummary = {
  id: string;
  revisionId: string;
  activationNumber: number;
  previousActivationNumber: number | null;
  canonicalDigest: string;
  createdAt: string;
  definition: CompiledFactoryDefinition;
};

export type SettingsFactoryDraftSummary = {
  id: string;
  baseActivationNumber: number | null;
  schemaVersion: number;
  canonicalDigest: string;
  createdAt: string;
  definition: CompiledFactoryDefinition;
};

export type SettingsFactoryDefinitionState = {
  factoryId: string | null;
  expectedActivationNumber: number;
  currentActivation: SettingsFactoryActivationSummary | null;
  latestDraft: SettingsFactoryDraftSummary | null;
  activeDefinition: CompiledFactoryDefinition | null;
  defaultRepositoryId: string | null;
  executionPolicy: ExecutionPolicy | null;
  deliveryPolicy: DeliveryPolicy | null;
  liveExecutionPolicyRevision: number;
  liveDeliveryPolicyRevision: number;
};

export type SettingsPipelineStagePatch = {
  id?: string | null;
  slug: string;
  name: string;
  description?: string;
  promptTemplateMd?: string;
  anyoneCanApprove?: boolean;
  approverMemberIds?: string[];
};

export type SettingsFactoryPatch =
  | {
      kind: "pipeline";
      name: string;
      operatingRulesMd: string;
      stages: SettingsPipelineStagePatch[];
    }
  | {
      kind: "agent";
      agent: {
        provider: AgentProvider;
        model: string;
        effort: AgentEffort | null;
        concurrencyLimit: number;
        stallTimeoutMs: number;
        maxRetries: number;
        maxTurns: number;
      };
    }
  | {
      kind: "execution-policy";
      expectedPolicyRevision: number;
      requirements: ExecutionRequirements;
    }
  | {
      kind: "delivery-policy";
      pipelineId: string;
      expectedPolicyRevision: number;
      requirements: DeliveryRequirements;
    }
  | {
      kind: "sandbox-provider";
      sandboxProvider: SandboxProvider;
    };

export type SettingsFactoryCommand =
  | {
      action: "draft";
      expectedActivationNumber: number;
      expectedDraftId: string | null;
      patch: SettingsFactoryPatch;
    }
  | {
      action: "publish";
      expectedActivationNumber: number;
      draftId: string;
    };

export type SettingsFactoryMutationErrorResponse = {
  error: string;
  diagnostics?: FactoryDefinitionDiagnostic[];
  fieldErrors?: Record<string, string>;
};

export function createEmptySettingsFactoryDefinitionState(): SettingsFactoryDefinitionState {
  return {
    factoryId: null,
    expectedActivationNumber: 0,
    currentActivation: null,
    latestDraft: null,
    activeDefinition: null,
    defaultRepositoryId: null,
    executionPolicy: null,
    deliveryPolicy: null,
    liveExecutionPolicyRevision: 0,
    liveDeliveryPolicyRevision: 0,
  };
}

export function canRouteSettingsThroughFactoryDraft(
  state: SettingsFactoryDefinitionState | null | undefined,
): state is SettingsFactoryDefinitionState {
  if (!state?.factoryId) return false;
  return Boolean(state.activeDefinition || state.defaultRepositoryId);
}
