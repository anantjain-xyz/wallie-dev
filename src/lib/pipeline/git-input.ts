import "server-only";

import { checkoutSandboxCheckpoint } from "@/lib/sandbox/checkout";
import type { SandboxHandle } from "@/lib/sandbox/types";

/** Restore the fixed generation input, verifying its retained ref when present. */
export async function checkoutPinnedGitInput(input: {
  sandbox: SandboxHandle;
  branch: string;
  sha: string;
  ref?: string;
  signal?: AbortSignal;
}): Promise<void> {
  await checkoutSandboxCheckpoint({
    ...input,
    checkpoint: { sha: input.sha, ...(input.ref ? { ref: input.ref } : {}) },
  });
}
