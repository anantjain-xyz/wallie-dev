import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

import { assertPathContained, sessionWorkspacePath } from "./paths";

export interface CreateWorkspaceResult {
  branch: string;
  path: string;
  sessionId: string;
}

/**
 * Provision a workspace directory for a session: clone the repo and check out
 * a fresh branch. The directory is deterministic on session ID so a
 * crash-and-restart picks up the same path.
 */
export async function createWorkspace(input: {
  baseDir?: string;
  branch?: string;
  repoUrl: string;
  sessionId: string;
}): Promise<CreateWorkspaceResult> {
  const wsPath = sessionWorkspacePath(input.sessionId, input.baseDir);
  const branch = input.branch ?? `wallie/session-${input.sessionId}`;

  // Ensure base directory exists.
  const baseDir = path.dirname(wsPath);
  await fs.promises.mkdir(baseDir, { recursive: true });

  // Validate containment before any filesystem writes.
  assertPathContained(wsPath, input.baseDir);

  // If workspace already exists (crash recovery), remove and re-clone to
  // ensure a clean state.
  if (fs.existsSync(wsPath)) {
    await fs.promises.rm(wsPath, { recursive: true, force: true });
  }

  // Clone the repo with --depth 1 to minimize disk and bandwidth.
  await gitExec(["clone", "--depth", "1", input.repoUrl, wsPath]);

  // Create and checkout a new branch for this session's work.
  await gitExec(["checkout", "-b", branch], wsPath);

  // Final containment check after clone (in case repoUrl contained symlinks).
  assertPathContained(wsPath, input.baseDir);

  return { branch, path: wsPath, sessionId: input.sessionId };
}

/**
 * Remove a session's workspace directory. Idempotent — succeeds if the
 * directory doesn't exist.
 */
export async function destroyWorkspace(input: {
  baseDir?: string;
  sessionId: string;
}): Promise<void> {
  const wsPath = sessionWorkspacePath(input.sessionId, input.baseDir);

  // Containment check: ensure the path we're about to delete is within
  // the workspace base. This prevents a malicious session ID from causing
  // deletion of arbitrary directories.
  assertPathContained(wsPath, input.baseDir);

  if (fs.existsSync(wsPath)) {
    await fs.promises.rm(wsPath, { recursive: true, force: true });
  }
}

/**
 * Check whether a workspace directory exists for a session.
 */
export function workspaceExists(input: { baseDir?: string; sessionId: string }): boolean {
  const wsPath = sessionWorkspacePath(input.sessionId, input.baseDir);
  return fs.existsSync(wsPath);
}

// --- helpers ---

function gitExec(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
