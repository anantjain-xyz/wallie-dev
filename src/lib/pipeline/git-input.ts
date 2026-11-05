import "server-only";

import { checkoutSandboxCheckpoint } from "@/lib/sandbox/checkout";
import type { SandboxHandle } from "@/lib/sandbox/types";

/** Initial-base compatibility path; retained-ref restores use the same contract. */
export async function checkoutPinnedGitInput(input: {
  sandbox: SandboxHandle;
  branch: string;
  sha: string;
  signal?: AbortSignal;
}): Promise<void> {
  await checkoutSandboxCheckpoint({ ...input, checkpoint: { sha: input.sha } });
}
