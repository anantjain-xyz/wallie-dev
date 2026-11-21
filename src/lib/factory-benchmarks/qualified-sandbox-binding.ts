import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

import {
  qualifiedSandboxBindingSchema,
  type QualifiedTrialIdentity,
} from "./qualified-trial-contracts";
import { BenchmarkReplayUnavailable, replaySha256 } from "./replay-contracts";

const bindingPath = "https://api.openai.com/.well-known/wallie-benchmark-bind";
const nonceLifetimeMs = 20_000;

// Probe programs are app-authored and run before the benchmark agent. The
// positive canary is a control request and never reaches the inference provider.
const canary = `
const fs = require("node:fs");
const [nonceFile, url] = process.argv.slice(1);
const nonce = fs.readFileSync(nonceFile, "utf8");
fs.unlinkSync(nonceFile);
fetch(url, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({nonce}), redirect:"error", signal:AbortSignal.timeout(5000)})
  .then((response) => { process.exitCode = response.status === 204 ? 0 : 1; }, () => { process.exitCode = 1; });
`;

// An empty POST reaches the relay's deny handler without provider credentials.
const verifyIsolation = `
const origins = ["https://github.com", "https://api.github.com", "https://slack.com", "https://api.linear.app", "https://api.vercel.com", "https://example.com"];
async function blocked(url) {
  try { await fetch(url, {method:"HEAD", redirect:"manual", signal:AbortSignal.timeout(3000)}); return false; }
  catch (error) { return error.name !== "TimeoutError"; }
}
Promise.all([...origins.map(blocked), fetch("https://api.openai.com/v1/files", {method:"POST", redirect:"manual", signal:AbortSignal.timeout(5000)})
  .then((response) => response.status === 403, () => false)])
  .then((checks) => { process.exitCode = checks.every(Boolean) ? 0 : 1; }, () => { process.exitCode = 1; });
`;

export function qualifiedTrialRpcIdentity(identity: QualifiedTrialIdentity) {
  return {
    p_trial_id: identity.trialId,
    p_job_id: identity.jobId,
    p_run_id: identity.runId,
    p_attempt_count: identity.attemptCount,
  };
}

export async function bindQualifiedSandbox(input: {
  admin: SupabaseClient<Database>;
  sandbox: SandboxHandle;
  identity: QualifiedTrialIdentity;
  deadlineAt: string;
  signal: AbortSignal;
}) {
  const { admin, sandbox, identity, deadlineAt, signal } = input;
  const nonce = randomBytes(32).toString("base64url");
  const scope = qualifiedTrialRpcIdentity(identity);
  const { data: armed, error } = await admin
    .rpc("arm_factory_benchmark_live_sandbox_binding", {
      ...scope,
      p_nonce_sha256: replaySha256(nonce),
      p_expires_at: new Date(
        Math.min(Date.parse(deadlineAt), Date.now() + nonceLifetimeMs),
      ).toISOString(),
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error || armed !== true)
    throw new BenchmarkReplayUnavailable("The isolated sandbox could not be armed.");

  const nonceFile = `/tmp/wallie-live-bind-${randomUUID()}`;
  try {
    await sandbox.writeFile(nonceFile, nonce, { mode: 0o600 });
    const request = await sandbox.exec("node", ["-e", canary, "--", nonceFile, bindingPath], {
      cwd: "/tmp",
      signal,
    });
    await request.exitCode;
  } finally {
    // The script consumes the file before sending; verify removal even when
    // execution fails before it opens the file.
    const removed = await sandbox.exec("rm", ["-f", "--", nonceFile], {
      cwd: "/tmp",
      signal: AbortSignal.timeout(5000),
    });
    if ((await removed.exitCode) !== 0)
      throw new BenchmarkReplayUnavailable("The sandbox binding input could not be removed.");
  }
  signal.throwIfAborted();

  // An acknowledged database binding is authoritative even if the canary's
  // response was lost. Never resubmit the once-consumed nonce.
  const bound = await admin
    .rpc("read_factory_benchmark_live_sandbox_binding", scope)
    .abortSignal(signal);
  const binding = qualifiedSandboxBindingSchema.safeParse(bound.data);
  if (bound.error || !binding.success)
    throw new BenchmarkReplayUnavailable(
      "The inference relay could not verify the sandbox identity.",
    );
  const probes = await sandbox.exec("node", ["-e", verifyIsolation], { cwd: "/tmp", signal });
  if ((await probes.exitCode) !== 0)
    throw new BenchmarkReplayUnavailable("The live replay network probes did not pass.");
  signal.throwIfAborted();
  return binding.data.signedSandboxId;
}
