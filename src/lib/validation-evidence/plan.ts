import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSandboxBoundedTextFile } from "@/lib/sandbox/bounded-text-file";
import type { Database } from "@/lib/supabase/database.types";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { readValidationIdentity, redactValidationCommand, redactValidationText } from "./capture";
import { browserRunIdentitySchema } from "./browser-contract";
import { validationPlanSchema, type ValidationPlan } from "./contracts";

const MAX_PLAN_BYTES = 64 * 1024;

export function validationPlanPath(runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid validation run identity.");
  return `/tmp/wallie-validation-plan-${runId}.json`;
}

export function validationPlanInstructions(runId: string): string {
  return `## Run validation plan

Write this run's validation commands to \`${validationPlanPath(runId)}\` before finishing. Wallie has initialized it with an empty plan. This file is outside the source checkout; Wallie saves an immutable copy with this run and independently executes it against the captured commit.

- Use this version-1 JSON shape: {"version":1,"commands":[{"key":"tests","command":"<repository test command>","timeoutSeconds":300,"reports":[]}]}
- Choose commands appropriate to this task and preserve any required evidence keys from the delivery policy. Each key must be unique. Include at most 20 commands; each timeout is 1–300 seconds.
- Commands must be noninteractive and leave the source unchanged. For a report, add {"key":"report","path":"tests.json","required":true,"kind":"report"} and write it to \`$WALLIE_EVIDENCE_DIR/tests.json\` during execution. Report paths are relative to that fresh output directory.
- If a policy requests visual verification, use version 2 with the same commands and a browser array. Each check has a unique key, a local path, timeoutSeconds (1–30), up to 12 interactions with action (click or expectVisible) and testId, regionTestId, excludedTestIds, and evidence entries with kind (screenshot or video) and boolean required. Wallie resolves its own isolated app target. Name visual requirements browser:<kind>:<check key>. Visual requests remain unavailable without an approved isolated capture runtime.
- Keep credentials and results out of the plan. Use environment variables for credentials. A plan is a request to execute checks, never proof that they passed.
- Leave commands empty for prose-only work. Do not create, edit, or commit \`.wallie/validation-evidence.json\`; it is obsolete and is never read. These run-specific instructions supersede earlier instructions to commit that file.`;
}

export async function prepareValidationPlan(sandbox: SandboxHandle, runId: string): Promise<void> {
  await sandbox.writeFile(validationPlanPath(runId), JSON.stringify({ version: 1, commands: [] }), {
    mode: 0o600,
  });
}

export async function readValidationPlan(input: {
  sandbox: SandboxHandle;
  runId: string;
  secrets: readonly string[];
  signal?: AbortSignal;
}): Promise<ValidationPlan> {
  const text = await readSandboxBoundedTextFile({
    sandbox: input.sandbox,
    path: validationPlanPath(input.runId),
    maxBytes: MAX_PLAN_BYTES,
    signal: input.signal,
  });
  if (text === null) throw new Error("Validation plan is unavailable or exceeds its limit.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Validation plan is invalid.");
  }
  const parsed = validationPlanSchema.safeParse(value);
  if (!parsed.success) throw new Error("Validation plan is invalid.");
  const metadata = JSON.stringify({
    commands: parsed.data.commands.map(({ key, reports }) => ({ key, reports })),
    browser: parsed.data.version === 2 ? parsed.data.browser : undefined,
  });
  if (
    redactValidationText(metadata, input.secrets) !== metadata ||
    parsed.data.commands.some(
      ({ command }) => redactValidationCommand(command, input.secrets) !== command,
    )
  )
    throw new Error("Validation plan contains sensitive material.");
  return parsed.data;
}

/** Persist before executing, then use the database's immutable copy. */
export async function pinValidationPlan(input: {
  admin: SupabaseClient<Database>;
  sandbox: SandboxHandle;
  runId: string;
  commitSha: string;
  secrets: readonly string[];
  signal?: AbortSignal;
}): Promise<
  | { plan: Extract<ValidationPlan, { version: 1 }> }
  | {
      plan: Extract<ValidationPlan, { version: 2 }>;
      browserIdentity: import("./browser-contract").BrowserRunIdentity;
    }
> {
  const plan = await readValidationPlan(input);
  const identity = await readValidationIdentity(input.sandbox, input.signal);
  if (!identity.clean || identity.commitSha !== input.commitSha)
    throw new Error("Validation checkpoint changed before plan capture.");
  const request = input.admin.rpc("pin_session_validation_plan", {
    p_run_id: input.runId,
    p_commit_sha: input.commitSha,
    p_validation_tree_sha: identity.treeSha,
    p_plan: plan,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  input.signal?.throwIfAborted();
  if (
    error ||
    !data ||
    data.run_id !== input.runId ||
    data.commit_sha !== input.commitSha ||
    data.validation_tree_sha !== identity.treeSha
  )
    throw new Error("Validation plan could not be saved.");
  const storedPlan = validationPlanSchema.parse(data.plan);
  if (storedPlan.version === 1) return { plan: storedPlan };
  return {
    plan: storedPlan,
    browserIdentity: browserRunIdentitySchema.parse({
      runId: data.run_id,
      attemptCount: data.attempt_count,
      commitSha: data.commit_sha,
      treeSha: data.validation_tree_sha,
    }),
  };
}
