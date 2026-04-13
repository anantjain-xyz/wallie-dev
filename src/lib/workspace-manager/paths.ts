import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Default base directory for agent workspaces. Overridden via
 * WALLIE_WORKSPACE_BASE_DIR environment variable.
 */
const DEFAULT_BASE_DIR = "/tmp/wallie-workspaces";

export function getWorkspaceBaseDir(env: Record<string, string | undefined> = process.env): string {
  return env.WALLIE_WORKSPACE_BASE_DIR?.trim() || DEFAULT_BASE_DIR;
}

/**
 * Compute the deterministic filesystem path for a session's workspace.
 * Uses the session ID directly — one session = one workspace directory.
 */
export function sessionWorkspacePath(sessionId: string, baseDir?: string): string {
  const base = baseDir ?? getWorkspaceBaseDir();
  // Sanitize session ID: only allow UUID characters (hex + dashes).
  const sanitized = sessionId.replace(/[^a-f0-9-]/gi, "");
  if (sanitized.length === 0) {
    throw new Error("Invalid session ID for workspace path");
  }
  return path.join(base, sanitized);
}

/**
 * Validate that a resolved path is contained within the workspace base dir.
 * Prevents symlink escapes and path traversal.
 */
export function assertPathContained(targetPath: string, baseDir?: string): void {
  const base = path.resolve(baseDir ?? getWorkspaceBaseDir());

  // Resolve the target — this follows symlinks if the path exists.
  let resolved: string;
  try {
    resolved = fs.realpathSync(targetPath);
  } catch {
    // Path doesn't exist yet — resolve without following symlinks.
    resolved = path.resolve(targetPath);
  }

  // The resolved path must start with the base dir + separator (or be the
  // base dir itself). This prevents "/tmp/wallie-workspaces-evil" from
  // passing when base is "/tmp/wallie-workspaces".
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path "${resolved}" escapes workspace base "${base}"`);
  }
}
