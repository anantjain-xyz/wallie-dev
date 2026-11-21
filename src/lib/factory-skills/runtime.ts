import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  trustedPromptValue,
  untrustedPromptValue,
  type PromptValue,
} from "@/lib/pipeline/prompt-safety";
import type { Database } from "@/lib/supabase/database.types";

/** Resolve retained revisions for an exact execution or candidate. */
export async function loadFactorySkillBundle(
  client: SupabaseClient<Database>,
  input: {
    workspaceId: string;
    factoryId: string;
    skillRevisionIds: readonly string[];
    requireCurrent?: true;
    signal?: AbortSignal;
  },
): Promise<PromptValue[]> {
  if (input.skillRevisionIds.length === 0) return [];

  const query = client
    .from("factory_skill_revisions")
    .select("id,content_md,content_sha256,source_kind")
    .eq("workspace_id", input.workspaceId)
    .eq("factory_id", input.factoryId)
    .in("id", input.skillRevisionIds);
  if (input.requireCurrent) query.is("revoked_at", null);
  const { data, error } = await (input.signal ? query.abortSignal(input.signal) : query);
  if (error) throw error;
  const revisions = new Map(data.map((row) => [row.id, row]));
  if (revisions.size !== input.skillRevisionIds.length) {
    throw new Error("A pinned skill revision is unavailable in this factory.");
  }

  return input.skillRevisionIds.map((id) => {
    const revision = revisions.get(id);
    if (!revision) throw new Error("A pinned skill revision is unavailable in this factory.");
    const digest = createHash("sha256").update(revision.content_md, "utf8").digest("hex");
    if (digest !== revision.content_sha256) {
      throw new Error("A pinned skill revision failed integrity verification.");
    }

    switch (revision.source_kind) {
      case "wallie_builtin":
      case "manual":
        return trustedPromptValue("skill.approvedInstructions", revision.content_md);
      case "repository":
        return untrustedPromptValue(`skill.repositoryRevision.${id}`, revision.content_md);
      default:
        throw new Error("A pinned skill revision has an unsupported source.");
    }
  });
}
