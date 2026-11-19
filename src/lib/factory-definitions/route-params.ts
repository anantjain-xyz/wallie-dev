import { z } from "zod";

import { workspaceIdParamsSchema } from "@/lib/workspaces";

export const factoryDefinitionRouteParamsSchema = workspaceIdParamsSchema.extend({
  factoryId: z.string().uuid().optional(),
});

export type FactoryDefinitionRouteContext = {
  params: Promise<z.input<typeof factoryDefinitionRouteParamsSchema>>;
};
