import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { readValidationIdentity, redactValidationCommand, redactValidationText } from "./capture";
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
- Keep credentials and results out of the plan. Use environment variables for credentials. A plan is a request to execute checks, never proof that they passed.
- Leave commands empty for prose-only work. Do not create, edit, or commit \`.wallie/validation-evidence.json\`; it is obsolete and is never read. These run-specific instructions supersede earlier instructions to commit that file.`;
}

export async function prepareValidationPlan(sandbox: SandboxHandle, runId: string): Promise<void> {
  await sandbox.writeFile(validationPlanPath(runId), JSON.stringify({ version: 1, commands: [] }), {
    mode: 0o600,
  });
}

const READ_PLAN = String.raw`
const fs = require('node:fs');
try {
  const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const buffer = Buffer.alloc(65537);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 65536 || count !== stat.size) throw new Error();
    const text = new (require('node:util').TextDecoder)('utf-8', {fatal:true}).decode(buffer.subarray(0,count));
    process.stdout.write(text);
  } finally { fs.closeSync(fd); }
} catch { process.exitCode = 1; }
`;

export async function readValidationPlan(input: {
  sandbox: SandboxHandle;
  runId: string;
  secrets: readonly string[];
  signal?: AbortSignal;
}): Promise<ValidationPlan> {
  input.signal?.throwIfAborted();
  const process = await input.sandbox.exec(
    "node",
    ["-e", READ_PLAN, validationPlanPath(input.runId)],
    {
      signal: input.signal,
    },
  );
  const [output, code] = await Promise.all([process.output(), process.exitCode]);
  input.signal?.throwIfAborted();
  if (code !== 0 || Buffer.byteLength(output.stdout) > MAX_PLAN_BYTES)
    throw new Error("Validation plan is unavailable or exceeds its limit.");
  let value: unknown;
  try {
    value = JSON.parse(output.stdout);
  } catch {
    throw new Error("Validation plan is invalid.");
  }
  const parsed = validationPlanSchema.safeParse(value);
  if (!parsed.success) throw new Error("Validation plan is invalid.");
  const metadata = JSON.stringify(
    parsed.data.commands.map(({ key, reports }) => ({ key, reports })),
  );
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
}): Promise<ValidationPlan> {
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
  return validationPlanSchema.parse(data.plan);
}
