import { z } from "zod";

const deploymentEnvironmentSchema = z.enum(["production", "preview", "development"]);

export const deployEnvSchema = z.object({
  WALLIE_DEPLOY_ENV: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    deploymentEnvironmentSchema.optional(),
  ),
});

type EnvInput = Record<string, string | undefined>;

export function getDeploymentEnvironment(input: EnvInput = process.env) {
  // Parse explicit settings first: a typo must not silently expose dev pages.
  const { WALLIE_DEPLOY_ENV } = deployEnvSchema.parse(input);
  if (WALLIE_DEPLOY_ENV) return WALLIE_DEPLOY_ENV;

  // Vercel previews also use NODE_ENV=production, so platform metadata wins.
  const vercelEnvironment = deploymentEnvironmentSchema.safeParse(input.VERCEL_ENV);
  if (vercelEnvironment.success) return vercelEnvironment.data;

  return input.NODE_ENV === "production" ? "production" : "development";
}

export const isProductionDeploy = (input: EnvInput = process.env) =>
  getDeploymentEnvironment(input) === "production";

export const isPreviewDeploy = (input: EnvInput = process.env) =>
  getDeploymentEnvironment(input) === "preview";

export const isVercelTelemetryEnabled = (input: EnvInput = process.env) =>
  isProductionDeploy(input) && input.VERCEL_ENV === "production";
