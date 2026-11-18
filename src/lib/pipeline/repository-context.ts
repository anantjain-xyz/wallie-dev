import "server-only";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function materializeFactoryRepositoryContext(input: {
  admin: AdminClient;
  factoryId: string;
  repositoryIds: readonly string[];
  sandbox: SandboxHandle;
  signal?: AbortSignal;
  workspaceId: string;
}): Promise<string[]> {
  const { admin, workspaceId, factoryId, signal, sandbox } = input;
  const snapshots: string[] = [];
  for (const repositoryId of input.repositoryIds) {
    signal?.throwIfAborted();
    try {
      const query = admin
        .from("github_repositories")
        .select("repo_id, full_name, github_installations!inner(installation_id)")
        .eq("id", repositoryId)
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("is_archived", false)
        .eq("github_installations.workspace_id", workspaceId)
        .eq("github_installations.suspended", false);
      const { data: repository, error } = await (
        signal ? query.abortSignal(signal) : query
      ).maybeSingle();
      if (error || !repository || !/^[\w-]+\/[\w.-]+$/.test(repository.full_name)) {
        throw new Error("Repository connection is unavailable.");
      }
      const installationId = repository.github_installations.installation_id;
      const token = await mintSandboxRepositoryToken({
        installationId,
        repositoryFullName: repository.full_name,
        repositoryId: repository.repo_id,
        purpose: "read-context",
      });
      signal?.throwIfAborted();
      // Look up the commit by numeric ID. A public repository that reuses a
      // stale owner/name must not supply a different context tree.
      const response = await fetch(
        `https://api.github.com/repositories/${repository.repo_id}/commits/HEAD`,
        {
          redirect: "error",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal,
        },
      );
      if (!response.ok) throw new Error("Repository commit is unavailable.");
      const { sha } = (await response.json()) as { sha?: unknown };
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) {
        throw new Error("Repository commit is invalid.");
      }
      const remote = `https://github.com/${repository.full_name}.git`;
      const command = await sandbox.exec(
        "bash",
        ["-c", archiveRepository, "wallie-read-context", remote, sha],
        {
          cwd: "/tmp",
          env: {
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            GIT_CONFIG_KEY_1: "http.followRedirects",
            GIT_CONFIG_VALUE_1: "false",
          },
          signal,
        },
      );
      const [{ stdout }, exitCode] = await Promise.all([command.output(), command.exitCode]);
      signal?.throwIfAborted();
      const snapshot = /^\/tmp\/wallie-read-context\.[a-zA-Z0-9]+\/files$/.exec(stdout.trim());
      if (exitCode !== 0 || !snapshot) throw new Error("Repository snapshot could not be read.");
      snapshots.push(`${repository.full_name} at ${sha} → ${snapshot[0]}`);
    } catch {
      signal?.throwIfAborted();
      // Provider errors may contain command arguments or credentials.
      throw new Error(
        "A factory read-context repository is unavailable. Restore its GitHub access before retrying.",
      );
    }
  }
  return snapshots;
}

// Scratch space is outside the source checkout. Export tracked files and
// remove the temporary bare clone and its config before launching the agent.
const archiveRepository = `set -euo pipefail
root="$(mktemp -d /tmp/wallie-read-context.XXXXXXXX)"
trap 'rm -rf -- "$root/repo.git"' EXIT
git init --quiet --bare --template= "$root/repo.git"
git --git-dir="$root/repo.git" fetch --quiet --no-tags --depth 1 "$1" "$2"
test "$(git --git-dir="$root/repo.git" rev-parse --verify 'FETCH_HEAD^{commit}')" = "$2"
mkdir "$root/files"
git --git-dir="$root/repo.git" archive "$2" | tar -x --no-same-owner --no-same-permissions -C "$root/files"
chmod -R a-w "$root/files"
printf '%s\\n' "$root/files"`;
