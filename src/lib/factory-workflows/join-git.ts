import { z } from "zod";
import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";

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
type GitOperations = {
  // Both operations run in one fresh, write-restricted sandbox repository.
  git: (
    args: string[],
    options: { signal: AbortSignal; env?: Record<string, string> },
  ) => Promise<ProcessResult>;
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

const conflictOutputLimit = 1024 * 1024;
const persistedPathCount = 32;
const pathByteLimit = 512;
const controlCharacter = /[\x00-\x1f\x7f]/;
const replacement = "\uFFFD";

function conflictPaths(output: string) {
  if (Buffer.byteLength(output) > conflictOutputLimit)
    throw new Error("Join conflict output exceeded its limit.");
  const fields = output.split("\0");
  // merge-tree prints a synthetic tree even on conflict. It is never a candidate.
  sha.parse(fields[0]);
  const end = fields.indexOf("", 1);
  if (end < 1) throw new Error("Join conflict path list was not terminated.");
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
  return { paths: retained, pathsTruncated: retained.length !== paths.length };
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
    return operations.git(
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { signal, env },
    );
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
    const merged = await git([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "-z",
      head,
      branch.outputSha,
    ]);
    signal.throwIfAborted();
    if (merged.code === 1) {
      return {
        kind: "conflict",
        edgeId: branch.edgeId,
        incomingSha: branch.outputSha,
        integratedThroughSha: head,
        ...conflictPaths(merged.stdout),
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
