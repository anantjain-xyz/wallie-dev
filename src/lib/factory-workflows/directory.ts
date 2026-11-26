import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { workflowBaseDefinitionSchema } from "./authoring-contracts";
import { workflowTemplateRevisionSchema } from "./workflow-templates";

const id = z.string().uuid().toLowerCase();
const revision = z.number().int().positive().safe();
const pageSize = 50;
const directorySchema = z.object({
  baseDefinition: workflowBaseDefinitionSchema.nullable(),
  cursorUnavailable: z.boolean(),
  workflows: z
    .array(
      z.object({
        workflowId: id,
        displayName: z.string().min(1).max(120),
        createdAt: z.string().datetime({ offset: true }),
        template: workflowTemplateRevisionSchema.nullable(),
        draftRevision: revision.nullable(),
        publication: z
          .object({
            activationId: id,
            draftId: id,
            draftRevision: revision,
            number: revision,
            intake: z.enum(["eligible", "definition_changed", "unavailable"]),
          })
          .nullable(),
      }),
    )
    .max(pageSize + 1),
});

const directorySearch = z
  .string()
  .trim()
  .max(120)
  .refine((text) => text.isWellFormed() && !text.includes("\0"))
  .optional();

export function parseWorkflowDirectoryQuery({ q, after }: { q?: unknown; after?: unknown }) {
  const search = directorySearch.safeParse(q);
  const cursor = id.optional().safeParse(after);
  return {
    q: search.success ? search.data : undefined,
    after: search.success && cursor.success ? cursor.data : undefined,
    needsReset: !search.success || !cursor.success,
  };
}

export async function loadWorkflowDirectory(
  supabase: SupabaseClient<Database>,
  { workspaceId, factoryId }: { workspaceId: string; factoryId: string },
  { q, after }: { q?: string; after?: string },
) {
  const { data, error } = await supabase.rpc("list_factory_workflow_directory", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    ...(q ? { p_search: q } : {}),
    ...(after ? { p_after_id: after } : {}),
  });
  if (error) throw error;
  if (data === null) return null;
  const { workflows, ...result } = directorySchema.parse(data);
  return {
    ...result,
    workflows: workflows.slice(0, pageSize),
    nextAfterId: workflows.length > pageSize ? workflows[pageSize - 1]?.workflowId : undefined,
  };
}
