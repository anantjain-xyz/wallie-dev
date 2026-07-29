import type { z } from "zod";

import {
  upsertDaytonaSandboxConnectionSchema,
  upsertE2BSandboxConnectionSchema,
} from "@/lib/sandbox-connections/contracts";
import type { SandboxCapabilityName } from "@/lib/sandbox-capabilities/contracts";
import { upsertVercelSandboxConnectionSchema } from "@/lib/vercel-sandbox/contracts";

import {
  SANDBOX_PROVIDER_IDS,
  type SandboxConnection,
  type SandboxProvider,
  type SandboxProviderDriver,
} from "./types";

export type ExplicitCapability<T> =
  | { state: "supported"; value: T }
  | { reason: string; state: "unsupported" };

export type SandboxProviderOperation = "acquire" | "listRunning" | "stopById" | "validate";

type ProviderDriverLoader = () => Promise<SandboxProviderDriver>;

export interface ProviderContract {
  authStrategy: {
    kind: "api-key" | "project-token";
    reservation: ExplicitCapability<{ owner: string }>;
  };
  capabilityProbes: {
    required: readonly SandboxCapabilityName[];
    workspaceFilter: ExplicitCapability<{ metadataKey: string }>;
  };
  cleanup: {
    acquisitionFailure: {
      kind: "stop-acquired-handle";
      owner: "finalizeSandboxAcquisition";
    };
    preProvision: ExplicitCapability<{
      kind: "recorded-workspace-ownership" | "vercel-project-cross-reference";
      owner: string;
    }>;
  };
  credentials: {
    fields: readonly string[];
    secretFields: readonly string[];
  };
  deadlines: Record<SandboxProviderOperation, number>;
  driver: {
    load: ProviderDriverLoader;
  };
  enablementPolicy: {
    defaultEnabled: boolean;
    environmentVariable: "WALLIE_ENABLED_SANDBOX_PROVIDERS";
    kind: "environment-allowlist";
  };
  label: string;
  readiness: {
    kind: "revision-aware-capability-check";
    owner: "assertCurrentSandboxCapabilityCheck";
  };
  reaper: ExplicitCapability<{
    kind: "revision-aware-provider-list";
    owner: "reapOrphanSandboxes";
  }>;
  settingsSchema: z.ZodTypeAny;
}

const REQUIRED_CAPABILITY_PROBES = [
  "git",
  "node",
  "packageManager",
  "agentCli",
  "playwrightPackage",
  "chromium",
  "screenshotSmoke",
] as const satisfies readonly SandboxCapabilityName[];

const DEFAULT_DEADLINES = {
  acquire: 30 * 60_000,
  listRunning: 30_000,
  stopById: 30_000,
  validate: 15_000,
} as const satisfies Record<SandboxProviderOperation, number>;

const DAYTONA_DEADLINES = {
  ...DEFAULT_DEADLINES,
  // Daytona's delete call has its own 60-second timeout. Keep the provider
  // contract outside that window so the SDK can finish or fail first.
  stopById: 65_000,
} as const satisfies Record<SandboxProviderOperation, number>;

const ENABLEMENT_POLICY = {
  defaultEnabled: true,
  environmentVariable: "WALLIE_ENABLED_SANDBOX_PROVIDERS",
  kind: "environment-allowlist",
} as const;

export const SANDBOX_PROVIDER_CONTRACTS = {
  daytona: {
    authStrategy: {
      kind: "api-key",
      reservation: {
        reason: "Daytona API keys are validated synchronously; there is no delegated auth flow.",
        state: "unsupported",
      },
    },
    capabilityProbes: {
      required: REQUIRED_CAPABILITY_PROBES,
      workspaceFilter: {
        state: "supported",
        value: { metadataKey: "wallie_workspace_id" },
      },
    },
    cleanup: {
      acquisitionFailure: {
        kind: "stop-acquired-handle",
        owner: "finalizeSandboxAcquisition",
      },
      preProvision: {
        state: "supported",
        value: {
          kind: "recorded-workspace-ownership",
          owner: "stopWorkspaceOwnedSandboxes",
        },
      },
    },
    credentials: {
      fields: ["apiKey", "apiUrl", "target"],
      secretFields: ["apiKey"],
    },
    deadlines: DAYTONA_DEADLINES,
    driver: {
      load: async () => (await import("./daytona")).daytonaSandboxDriver,
    },
    enablementPolicy: ENABLEMENT_POLICY,
    label: "Daytona",
    readiness: {
      kind: "revision-aware-capability-check",
      owner: "assertCurrentSandboxCapabilityCheck",
    },
    reaper: {
      state: "supported",
      value: {
        kind: "revision-aware-provider-list",
        owner: "reapOrphanSandboxes",
      },
    },
    settingsSchema: upsertDaytonaSandboxConnectionSchema,
  },
  e2b: {
    authStrategy: {
      kind: "api-key",
      reservation: {
        reason: "E2B API keys are validated synchronously; there is no delegated auth flow.",
        state: "unsupported",
      },
    },
    capabilityProbes: {
      required: REQUIRED_CAPABILITY_PROBES,
      workspaceFilter: {
        state: "supported",
        value: { metadataKey: "wallie_workspace_id" },
      },
    },
    cleanup: {
      acquisitionFailure: {
        kind: "stop-acquired-handle",
        owner: "finalizeSandboxAcquisition",
      },
      preProvision: {
        state: "supported",
        value: {
          kind: "recorded-workspace-ownership",
          owner: "stopWorkspaceOwnedSandboxes",
        },
      },
    },
    credentials: {
      fields: ["apiKey"],
      secretFields: ["apiKey"],
    },
    deadlines: DEFAULT_DEADLINES,
    driver: {
      load: async () => (await import("./e2b")).e2bSandboxDriver,
    },
    enablementPolicy: ENABLEMENT_POLICY,
    label: "E2B",
    readiness: {
      kind: "revision-aware-capability-check",
      owner: "assertCurrentSandboxCapabilityCheck",
    },
    reaper: {
      state: "supported",
      value: {
        kind: "revision-aware-provider-list",
        owner: "reapOrphanSandboxes",
      },
    },
    settingsSchema: upsertE2BSandboxConnectionSchema,
  },
  vercel: {
    authStrategy: {
      kind: "project-token",
      reservation: {
        reason:
          "Vercel project tokens are validated synchronously; there is no delegated auth flow.",
        state: "unsupported",
      },
    },
    capabilityProbes: {
      required: REQUIRED_CAPABILITY_PROBES,
      workspaceFilter: {
        reason: "Vercel lists at project scope, so Wallie cross-references recorded ownership.",
        state: "unsupported",
      },
    },
    cleanup: {
      acquisitionFailure: {
        kind: "stop-acquired-handle",
        owner: "finalizeSandboxAcquisition",
      },
      preProvision: {
        state: "supported",
        value: {
          kind: "vercel-project-cross-reference",
          owner: "stopVercelWorkspaceOwnedSandboxes",
        },
      },
    },
    credentials: {
      fields: ["projectId", "teamId", "token"],
      secretFields: ["token"],
    },
    deadlines: DEFAULT_DEADLINES,
    driver: {
      load: async () => (await import("./vercel")).vercelSandboxDriver,
    },
    enablementPolicy: ENABLEMENT_POLICY,
    label: "Vercel Sandbox",
    readiness: {
      kind: "revision-aware-capability-check",
      owner: "assertCurrentSandboxCapabilityCheck",
    },
    reaper: {
      state: "supported",
      value: {
        kind: "revision-aware-provider-list",
        owner: "reapOrphanSandboxes",
      },
    },
    settingsSchema: upsertVercelSandboxConnectionSchema,
  },
} satisfies Record<SandboxProvider, ProviderContract>;

export const PROVIDER_CONTRACT_SEMANTIC_OWNERS = {
  authStrategy: "sandbox connection authentication",
  capabilityProbes: "sandbox runtime capability verification",
  "capabilityProbes.workspaceFilter": "provider-scoped capability discovery",
  cleanup: "sandbox lifecycle cleanup",
  "cleanup.acquisitionFailure": "sandbox acquisition failure cleanup",
  "cleanup.preProvision": "sandbox connection rotation cleanup",
  credentials: "sandbox connection credential storage",
  deadlines: "bounded provider remote operations",
  driver: "sandbox runtime dispatch",
  enablementPolicy: "deployment provider enablement",
  label: "operator-facing provider naming",
  readiness: "session readiness gate",
  reaper: "orphan sandbox recovery",
  settingsSchema: "sandbox connection input validation",
} as const;

type ProviderContractPath = keyof typeof PROVIDER_CONTRACT_SEMANTIC_OWNERS;

export type ProviderContractDiagnostic = {
  message: string;
  owner: (typeof PROVIDER_CONTRACT_SEMANTIC_OWNERS)[ProviderContractPath];
  path: ProviderContractPath;
  provider: string;
};

const EXPLICIT_CAPABILITY_PATHS = [
  "authStrategy.reservation",
  "capabilityProbes.workspaceFilter",
  "cleanup.preProvision",
  "reaper",
] as const;

export function getSandboxProviderContract(provider: SandboxProvider): ProviderContract {
  return SANDBOX_PROVIDER_CONTRACTS[provider];
}

export function listSandboxProviders(): SandboxProvider[] {
  return [...SANDBOX_PROVIDER_IDS];
}

export function providerLabel(provider: SandboxProvider): string {
  return getSandboxProviderContract(provider).label;
}

export function verifySandboxProviderContracts(
  registry: Record<string, unknown>,
  expectedProviders: readonly string[],
): ProviderContractDiagnostic[] {
  const diagnostics: ProviderContractDiagnostic[] = [];

  for (const provider of expectedProviders) {
    const contract = registry[provider];
    if (!isRecord(contract)) {
      diagnostics.push(missingDiagnostic(provider, "driver"));
      continue;
    }

    for (const path of Object.keys(PROVIDER_CONTRACT_SEMANTIC_OWNERS) as ProviderContractPath[]) {
      if (readPath(contract, path) === undefined) {
        diagnostics.push(missingDiagnostic(provider, path));
      }
    }

    for (const path of EXPLICIT_CAPABILITY_PATHS) {
      const capability = readPath(contract, path);
      if (!isExplicitCapability(capability)) {
        const ownerPath = path === "authStrategy.reservation" ? "authStrategy" : path;
        diagnostics.push({
          message: `Sandbox provider "${provider}" must declare "${path}" as supported or unsupported (semantic owner: ${PROVIDER_CONTRACT_SEMANTIC_OWNERS[ownerPath]}).`,
          owner: PROVIDER_CONTRACT_SEMANTIC_OWNERS[ownerPath],
          path: ownerPath,
          provider,
        });
      }
    }
  }

  return diagnostics;
}

export function assertSandboxProviderContracts(): void {
  const diagnostics = verifySandboxProviderContracts(
    SANDBOX_PROVIDER_CONTRACTS,
    SANDBOX_PROVIDER_IDS,
  );
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
}

function missingDiagnostic(
  provider: string,
  path: ProviderContractPath,
): ProviderContractDiagnostic {
  const owner = PROVIDER_CONTRACT_SEMANTIC_OWNERS[path];
  return {
    message: `Sandbox provider "${provider}" is missing contract field "${path}" (semantic owner: ${owner}).`,
    owner,
    path,
    provider,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isExplicitCapability(
  value: unknown,
): value is ExplicitCapability<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  if (value.state === "supported") return "value" in value;
  return (
    value.state === "unsupported" && typeof value.reason === "string" && value.reason.length > 0
  );
}

type ConnectionFor<Provider extends SandboxProvider> = Extract<
  SandboxConnection,
  { provider: Provider }
>;

// This type assertion is the single generic boundary between the exhaustive
// registry and a connection-narrowed driver selected by its discriminant.
export async function loadSandboxProviderDriver<Provider extends SandboxProvider>(
  provider: Provider,
): Promise<SandboxProviderDriver<ConnectionFor<Provider>>> {
  return (await getSandboxProviderContract(provider).driver.load()) as SandboxProviderDriver<
    ConnectionFor<Provider>
  >;
}

assertSandboxProviderContracts();
