import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  restoreAndPushSourceWithWorkspace,
  type GitExecutor,
  type SourceRestoreInput,
} from "./source-delivery-git-core";

/** Local transport retained for Node deployments and real Git regression tests. */
export async function restoreAndPushSource(
  input: SourceRestoreInput,
  dependencies: { execGit?: GitExecutor } = {},
): Promise<string> {
  const exec = promisify(execFile);
  return restoreAndPushSourceWithWorkspace(input, {
    execGit:
      dependencies.execGit ??
      (async (args, options) => exec("git", args, { ...options, encoding: "utf8" })),
    createWorkspace: async () => {
      const path = await mkdtemp(join(tmpdir(), "wallie-source-delivery-"));
      return {
        path,
        writeBundle: async (bytes) => {
          await writeFile(join(path, "source.bundle"), bytes, { mode: 0o600 });
        },
        close: () => rm(path, { recursive: true, force: true }),
      };
    },
  });
}
