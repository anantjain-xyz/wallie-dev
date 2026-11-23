import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";

import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
type Observation =
  Database["public"]["Functions"]["list_factory_workflow_branch_repository_bases"]["Returns"][number];

const positiveInt = z.number().int().positive().safe();
const repositoryIdentity = z.object({
  id: positiveInt,
  full_name: z.string(),
  default_branch: z.string().min(1),
});
const branchIdentity = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
});

async function observeRepositoryBase(scope: Observation, signal: AbortSignal): Promise<string> {
  const token = await mintSandboxRepositoryToken({
    installationId: scope.installation_numeric_id,
    repositoryId: scope.repository_numeric_id,
    repositoryFullName: scope.repository_full_name,
    purpose: "checkout",
    signal,
  });
  const path = scope.repository_full_name.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Wallie",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repository = await fetch(url, { headers, redirect: "error", signal });
  if (!repository.ok) throw new Error("The branch repository is unavailable.");
  const identity = repositoryIdentity.parse(await repository.json());
  if (
    identity.id !== scope.repository_numeric_id ||
    identity.full_name.toLowerCase() !== scope.repository_full_name.toLowerCase() ||
    identity.default_branch !== scope.base_branch
  ) {
    throw new Error("The branch repository identity changed.");
  }
  const response = await fetch(`${url}/branches/${encodeURIComponent(scope.base_branch)}`, {
    headers,
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("The branch repository base is unavailable.");
  const branch = branchIdentity.parse(await response.json());
  if (branch.name !== scope.base_branch) throw new Error("The branch repository base changed.");
  return branch.commit.sha;
}

export async function pinPendingFactoryWorkflowRepositoryBases(admin: Admin): Promise<void> {
  const { data, error } = await admin
    .rpc("list_factory_workflow_branch_repository_bases")
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw error;

  await Promise.all(
    data.map(async (observation) => {
      const signal = AbortSignal.timeout(8_000);
      try {
        const observedSha = observation.requires_observation
          ? await observeRepositoryBase(observation, signal)
          : undefined;
        const result = await admin
          .rpc("pin_factory_workflow_branch_repository_base", {
            p_root_session_id: observation.root_session_id,
            p_workspace_id: observation.workspace_id,
            p_factory_id: observation.factory_id,
            p_group_id: observation.group_id,
            p_expected_generation: observation.generation,
            p_repository_id: observation.repository_id,
            p_installation_id: observation.installation_id,
            p_installation_numeric_id: observation.installation_numeric_id,
            p_repository_numeric_id: observation.repository_numeric_id,
            p_base_branch: observation.base_branch,
            ...(observedSha ? { p_observed_sha: observedSha } : {}),
          })
          .abortSignal(signal);
        if (result.error) throw result.error;
      } catch {
        console.warn("[factory-workflow] repository base unavailable", {
          workspaceId: observation.workspace_id,
          repositoryId: observation.repository_id,
          branchGroupId: observation.group_id,
        });
      }
    }),
  );
}
