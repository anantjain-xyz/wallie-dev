import { z } from "zod";

import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import { factoryDefinitionExpectedActivationSchema } from "./schema";

const repository = z.object({ id: z.string().uuid(), fullName: z.string() });
const version = z.object({
  expectedActivationNumber: factoryDefinitionExpectedActivationSchema,
  expectedDraftId: z.string().uuid().nullable(),
});
const assignRepository = z.object({
  action: z.literal("assign-repository"),
  repositoryId: z.string().uuid(),
});
const createPipeline = z.object({ action: z.literal("create-pipeline") });

export const factorySetupCommandSchema = z.discriminatedUnion("action", [
  version.merge(assignRepository).strict(),
  version.merge(createPipeline).strict(),
]);
export const factorySetupRepositoryOptionsSchema = z.object({ repositories: repository.array() });
export const factorySetupMutationResponseSchema = z.object({ id: z.string().uuid() });
export const factorySetupSnapshotSchema = z.object({
  repositories: repository.array(),
  pipelineAvailable: z.boolean(),
  enabledSandboxProviders: sandboxProviderSchema.array(),
});

export type FactorySetupAction = z.infer<typeof assignRepository | typeof createPipeline>;
export type FactorySetupSnapshot = z.infer<typeof factorySetupSnapshotSchema>;
