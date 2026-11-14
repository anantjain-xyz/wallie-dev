import { z } from "zod";

import { AGENT_PROVIDERS } from "@/lib/agent-config/contracts";
import { Constants } from "@/lib/supabase/database.types";

const workspaceId = z.string().uuid();
const runId = z.string().uuid();

export const runCatalogParamsSchema = z.object({ workspaceId });
export const runCatalogItemParamsSchema = runCatalogParamsSchema.extend({ runId });

export const RUN_CATALOG_PAGE_SIZE = 20;
export const RUN_CATALOG_MAX_PAGE_SIZE = 50;

export const runCatalogFiltersSchema = z.object({
  sessionId: z.string().uuid().optional(),
  status: z.enum(Constants.public.Enums.agent_run_status).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional(),
  stageId: z.string().uuid().optional(),
});

export const runCatalogQuerySchema = runCatalogFiltersSchema
  .extend({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().int().max(RUN_CATALOG_MAX_PAGE_SIZE))
      .optional(),
  })
  .strict();

export type RunCatalogFilters = z.infer<typeof runCatalogFiltersSchema>;
export type RunCatalogQuery = z.output<typeof runCatalogQuerySchema>;
