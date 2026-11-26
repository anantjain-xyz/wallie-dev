import { z } from "zod";

import { factoryCommandScopesSchema } from "@/lib/factory-machine-tokens/contracts";

export const auditDetailSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().uuid().optional(),
  oauthGrantId: z.string().uuid().optional(),
  grantVersion: z.number().int().positive().safe().optional(),
  scopes: factoryCommandScopesSchema.optional(),
  command_scopes: factoryCommandScopesSchema.optional(),
  reason: z.unknown().optional(),
  bindingId: z.string().optional(),
  name: z.string().optional(),
  agentProvider: z.string().optional(),
  version: z.number().int().positive().safe().optional(),
  service_principal_id: z.string().uuid().optional(),
  servicePrincipalId: z.string().uuid().optional(),
  executionGrantId: z.string().uuid().optional(),
  grantId: z.string().uuid().optional(),
  factoryAgentId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  revisionId: z.string().uuid().optional(),
  github_repository_id: z.string().uuid().optional(),
  read_context_repository_ids: z.array(z.string()).optional(),
  tool_ids: z.array(z.string()).optional(),
  execution_policy_revision_id: z.string().uuid().optional(),
  budget_payer_member_id: z.string().uuid().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  revocation_reason: z.string().nullable().optional(),
});
