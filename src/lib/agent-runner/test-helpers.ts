import type { FakeSandbox } from "@/lib/sandbox/fake";

export function harnessPath(sandbox: FakeSandbox, relativePath: string): string {
  const directory = sandbox.calls.findLast((call) => call.cmd === "mkdir")?.args[2];
  if (!directory) throw new Error("Runner did not prepare a private directory.");
  return `${directory}/${relativePath}`;
}

/** Existing runner assertions distinguish CLI/auth setup from private-directory setup. */
export function runnerCalls(sandbox: FakeSandbox) {
  return sandbox.calls.filter((call) => call.cmd !== "mkdir");
}
