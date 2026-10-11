import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import type { SourceDelivery } from "./source-delivery";

type PullRequest = {
  number: number;
  html_url: string;
  draft: boolean;
  state: string;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
};

/** Read-before-create plus a recovery read makes ambiguous GitHub writes retryable. */
export async function ensureSourcePullRequest(input: {
  admin: SupabaseClient<Database>;
  delivery: SourceDelivery;
  token: string;
  signal: AbortSignal;
  verifyOwnership: () => Promise<void>;
}) {
  const { delivery, signal } = input;
  if (!delivery.repository_id) throw new Error("Source repository connection is unavailable.");
  const [owner, repo, extra] = delivery.repository_full_name.split("/");
  if (!owner || !repo || extra || !/^[\w.-]+\/[\w.-]+$/.test(delivery.repository_full_name))
    throw new Error("Invalid source repository.");
  const request = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    signal.throwIfAborted();
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
      method: body ? "POST" : "GET",
      signal,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("GitHub request failed.");
    return (await response.json()) as T;
  };
  const matchesHead = (pr: PullRequest) =>
    pr.head?.ref === delivery.branch_name &&
    pr.head.repo?.full_name.toLowerCase() === delivery.repository_full_name.toLowerCase();
  const containsDeliveredHead = async (pr: PullRequest) => {
    if (pr.head.sha === delivery.head_sha) return true;
    if (!/^[a-f0-9]{40}$/.test(pr.head.sha ?? "")) return false;
    const comparison = await request<{ status: string }>(
      `compare/${delivery.head_sha}...${pr.head.sha}`,
    );
    return comparison.status === "ahead" || comparison.status === "identical";
  };
  const find = async () => {
    signal.throwIfAborted();
    const data = await request<PullRequest[]>(
      `pulls?${new URLSearchParams({ head: `${owner}:${delivery.branch_name}`, state: "all" })}`,
    );
    const matching = data
      .filter(matchesHead)
      .sort((a, b) => Number(b.state === "open") - Number(a.state === "open"));
    for (const pr of matching) {
      if (await containsDeliveredHead(pr)) return pr;
    }
    return undefined;
  };
  let pr = await find();
  if (!pr) {
    signal.throwIfAborted();
    await input.verifyOwnership();
    try {
      pr = await request<PullRequest>("pulls", {
        base: delivery.base_branch,
        head: delivery.branch_name,
        title: delivery.title,
        body: delivery.body,
      });
      if (!matchesHead(pr) || !(await containsDeliveredHead(pr)))
        throw new Error("Pull request source does not contain the delivered commit.");
    } catch {
      pr = await find();
      if (!pr) {
        // The base may have absorbed the source while delivery was delayed.
        const comparison = await request<{ status: string }>(
          `compare/${encodeURIComponent(delivery.base_branch)}...${delivery.head_sha}`,
        );
        if (comparison.status === "behind" || comparison.status === "identical") return;
        throw new Error("Pull request delivery failed.");
      }
    }
  }
  signal.throwIfAborted();
  await input.verifyOwnership();
  const { error } = await input.admin
    .rpc("record_session_pull_request", {
      target_branch_name: delivery.branch_name,
      target_repository_id: delivery.repository_id,
      source_is_draft: pr.draft,
      source_pull_request_number: pr.number,
      source_pull_request_state: pr.merged_at ? "merged" : pr.state,
      source_pull_request_url: pr.html_url,
      target_session_id: delivery.session_id,
      target_workspace_id: delivery.workspace_id,
      source_updated_at: pr.updated_at,
    })
    .abortSignal(signal);
  if (error) throw new Error("Pull request metadata could not be recorded.");
}
