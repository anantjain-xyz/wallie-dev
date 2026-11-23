import { z } from "zod";
import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";
import type { SandboxHandle } from "@/lib/sandbox/types";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const runId = z.string().uuid();
const inputSchema = z.strictObject({
  edgeId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  checkpointRunId: runId,
  inputSha: sha,
  outputSha: sha,
  retainedRef: z.string().nullable(),
});
const planSchema = z.strictObject({
  joinId: runId,
  admittedAt: z.string().datetime({ offset: true }),
  parent: z.strictObject({
    checkpointRunId: runId,
    inputSha: sha.optional(),
    outputSha: sha,
    retainedRef: z.string().nullable(),
  }),
  branches: z.array(inputSchema).min(1).max(128),
});

type ProcessResult = { stdout: string; code: number };
type MergeResult = ProcessResult & { truncated: boolean };
type GitOperations = {
  // These operations run in one fresh, write-restricted sandbox repository.
  git: (
    args: string[],
    options: { signal: AbortSignal; env?: Record<string, string> },
  ) => Promise<ProcessResult>;
  merge: (args: string[], options: { signal: AbortSignal }) => Promise<MergeResult>;
  // The adapter authenticates only this Git network request and fetches the exact selector.
  fetch: (selector: string, signal: AbortSignal) => Promise<void>;
};

export type JoinPlan = z.input<typeof planSchema>;

export type IntegrationOutcome =
  | { kind: "candidate"; commitSha: string; treeSha: string }
  | {
      kind: "conflict";
      edgeId: string;
      incomingSha: string;
      integratedThroughSha: string;
      paths: string[];
      pathsTruncated: boolean;
    };

const mergeOutputLimit = 64 * 1024;
const gitConfig = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"];
const mergeOutputSchema = z.strictObject({
  prefix: z.string().max(Math.ceil(mergeOutputLimit / 3) * 4),
  truncated: z.boolean(),
});

// Drain the entire child stream to preserve Git's real exit status. Only complete
// records in the retained prefix can cross the sandbox transport.
const boundedMerge = String.raw`
const { spawn } = require("node:child_process");
const git = spawn("git", process.argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
const prefix = Buffer.alloc(${mergeOutputLimit});
let length = 0;
let truncated = false;
git.stdout.on("data", (chunk) => {
  const copied = chunk.copy(prefix, length);
  length += copied;
  truncated ||= copied !== chunk.length;
});
git.on("error", () => { process.exitCode = 127; });
git.on("close", (code) => {
  process.exitCode ??= code ?? 2;
  const retained = prefix.subarray(0, length);
  const boundary = retained.lastIndexOf(0) + 1;
  process.stdout.write(JSON.stringify({
    prefix: retained.subarray(0, boundary).toString("base64"),
    truncated: truncated || boundary !== retained.length,
  }));
});
`;

export async function runBoundedJoinMerge(
  sandbox: Pick<SandboxHandle, "exec">,
  args: string[],
  options: { signal: AbortSignal; env?: Record<string, string> },
): Promise<MergeResult> {
  const { signal } = options;
  signal.throwIfAborted();
  const command = await sandbox.exec("node", ["-e", boundedMerge, "--", ...args], options);
  const [{ stdout }, code] = await Promise.all([command.output(), command.exitCode]);
  signal.throwIfAborted();
  if (code !== 0 && code !== 1) return { stdout: "", code, truncated: false };
  const envelope = mergeOutputSchema.parse(JSON.parse(stdout));
  return {
    stdout: Buffer.from(envelope.prefix, "base64").toString("utf8"),
    code,
    truncated: envelope.truncated,
  };
}

const persistedPathCount = 32;
const pathByteLimit = 512;
const controlCharacter = /[\x00-\x1f\x7f]/;
const replacement = "\uFFFD";

function conflictPaths({ stdout, truncated }: MergeResult) {
  const fields = stdout.split("\0");
  // merge-tree prints a synthetic tree even on conflict. It is never a candidate.
  if (!sha.safeParse(fields[0]).success) throw new Error("Join merge operation failed.");
  const end = fields.indexOf("", 1);
  if (end < 1 || (!truncated && end === fields.length - 1))
    throw new Error("Join conflict path list was not terminated.");
  const paths = fields.slice(1, end);
  const usable = [...new Set(paths)].filter(
    (path) =>
      !!path &&
      !path.startsWith("/") &&
      !path.includes(replacement) &&
      !controlCharacter.test(path) &&
      !path.split("/").some((part) => part === "..") &&
      Buffer.byteLength(path) <= pathByteLimit,
  );
  let persistedBytes = 0;
  const retained = [];
  for (const path of usable.sort()) {
    persistedBytes += Buffer.byteLength(JSON.stringify(path)) + 1;
    if (persistedBytes > 4 * 1024 || retained.length === persistedPathCount) break;
    retained.push(path);
  }
  return {
    paths: retained,
    pathsTruncated: truncated || retained.length === 0 || retained.length !== paths.length,
  };
}

export async function integrateJoin(
  rawPlan: JoinPlan,
  operations: GitOperations,
  signal: AbortSignal,
): Promise<IntegrationOutcome> {
  const plan = planSchema.parse(rawPlan);
  const branches = [...plan.branches].sort((left, right) =>
    left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0,
  );
  if (new Set(branches.map((branch) => branch.edgeId)).size !== branches.length)
    throw new Error("The sealed join has duplicate branch edges.");
  for (const checkpoint of [plan.parent, ...branches]) {
    if (
      checkpoint.retainedRef !== null &&
      !isWallieCheckpointRef(
        checkpoint.retainedRef,
        checkpoint.outputSha,
        // No-code checkpoints can retain the verified ref of the run that
        // originally published these same bytes.
        checkpoint.inputSha === checkpoint.outputSha ? undefined : checkpoint.checkpointRunId,
      )
    )
      throw new Error("Join input has an unexpected retained ref.");
  }
  const git = (args: string[], env?: Record<string, string>) => {
    signal.throwIfAborted();
    return operations.git([...gitConfig, ...args], { signal, env });
  };
  async function required(args: string[], env?: Record<string, string>) {
    const result = await git(args, env);
    signal.throwIfAborted();
    if (result.code !== 0) throw new Error("Join Git operation failed.");
    return result.stdout.trim();
  }
  async function ancestor(expectedAncestor: string, descendant: string) {
    const probe = await git(["merge-base", "--is-ancestor", expectedAncestor, descendant]);
    signal.throwIfAborted();
    if (probe.code > 1 || probe.code < 0) throw new Error("Join ancestry could not be verified.");
    return probe.code === 0;
  }
  async function fetchExact(checkpoint: (typeof branches)[number] | typeof plan.parent) {
    await operations.fetch(checkpoint.retainedRef ?? checkpoint.outputSha, signal);
    const fetched = sha.parse(await required(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]));
    if (fetched !== checkpoint.outputSha)
      throw new Error("A retained join input changed after admission.");
  }

  await required(["init", "--bare", "--object-format=sha1", "--quiet"]);
  await fetchExact(plan.parent);
  let head = plan.parent.outputSha;
  const seconds = Math.floor(Date.parse(plan.admittedAt) / 1000);
  const env = {
    GIT_AUTHOR_NAME: "Wallie",
    GIT_AUTHOR_EMAIL: "wallie@users.noreply.github.com",
    GIT_AUTHOR_DATE: "@" + seconds + " +0000",
    GIT_COMMITTER_NAME: "Wallie",
    GIT_COMMITTER_EMAIL: "wallie@users.noreply.github.com",
    GIT_COMMITTER_DATE: "@" + seconds + " +0000",
  };
  // Read and verify the complete frozen input set even when an earlier merge conflicts.
  for (const branch of branches) {
    if (branch.outputSha !== plan.parent.outputSha || branch.retainedRef !== null)
      await fetchExact(branch);
    if (
      !(await ancestor(plan.parent.outputSha, branch.inputSha)) ||
      !(await ancestor(branch.inputSha, branch.outputSha))
    )
      throw new Error("A selected branch has unrelated checkpoint ancestry.");
  }
  for (const branch of branches) {
    if (await ancestor(branch.outputSha, head)) continue;
    signal.throwIfAborted();
    const merged = await operations.merge(
      [...gitConfig, "merge-tree", "--write-tree", "--name-only", "-z", head, branch.outputSha],
      { signal },
    );
    signal.throwIfAborted();
    if (merged.code === 1) {
      return {
        kind: "conflict",
        edgeId: branch.edgeId,
        incomingSha: branch.outputSha,
        integratedThroughSha: head,
        ...conflictPaths(merged),
      };
    }
    if (merged.code !== 0) throw new Error("Join merge operation failed.");
    const tree = sha.parse(merged.stdout.split("\0")[0]?.trim());
    head = sha.parse(
      await required(
        [
          "commit-tree",
          tree,
          "-p",
          head,
          "-p",
          branch.outputSha,
          "-m",
          "Wallie workflow join " + plan.joinId + " / " + branch.edgeId,
        ],
        env,
      ),
    );
  }
  for (const input of [plan.parent, ...branches]) {
    if (!(await ancestor(input.outputSha, head)))
      throw new Error("The joined checkpoint discarded a selected branch.");
  }
  return {
    kind: "candidate",
    commitSha: head,
    treeSha: sha.parse(await required(["rev-parse", "--verify", head + "^{tree}"])),
  };
}
