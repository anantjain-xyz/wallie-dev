import { SANDBOX_PROVIDER_CONTRACTS, type ProviderContract } from "./provider-contract";
import { SANDBOX_PROVIDER_IDS } from "./types";

export const COMPLETE_PROVIDER_REGISTRY_FIXTURE = {
  ...SANDBOX_PROVIDER_CONTRACTS,
} satisfies Record<(typeof SANDBOX_PROVIDER_IDS)[number], ProviderContract>;

const incompleteProviderContract = ((contract: typeof SANDBOX_PROVIDER_CONTRACTS.vercel) => {
  const { cleanup, ...incomplete } = contract;
  void cleanup;
  return incomplete;
})(SANDBOX_PROVIDER_CONTRACTS.vercel);

type FixtureProvider = (typeof SANDBOX_PROVIDER_IDS)[number] | "incomplete";

// This fixture is deliberately incomplete. The expectation is a compile-time
// tripwire: if cleanup ever becomes optional, TypeScript reports this directive
// as unused and the normal typecheck fails.
const INCOMPLETE_PROVIDER_COMPILE_FIXTURE = {
  ...SANDBOX_PROVIDER_CONTRACTS,
  // @ts-expect-error "incomplete" intentionally omits the required cleanup semantic owner.
  incomplete: incompleteProviderContract,
} satisfies Record<FixtureProvider, ProviderContract>;

void INCOMPLETE_PROVIDER_COMPILE_FIXTURE;

export const INCOMPLETE_PROVIDER_REGISTRY_FIXTURE: Record<string, unknown> = {
  ...SANDBOX_PROVIDER_CONTRACTS,
  incomplete: incompleteProviderContract,
};

export const INCOMPLETE_PROVIDER_IDS_FIXTURE = [...SANDBOX_PROVIDER_IDS, "incomplete"] as const;
