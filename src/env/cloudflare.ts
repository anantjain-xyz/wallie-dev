import { z } from "zod";

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

export const workerWakeEnvSchema = z.object({
  WALLIE_WORKER_WAKE_URL: optional(
    z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
        );
      }, "Worker wake URL must use HTTPS (HTTP is allowed for localhost only)."),
  ),
  WALLIE_WORKER_WAKE_SECRET: optional(z.string().min(32)),
});

export const cloudflareEnvSchema = workerWakeEnvSchema.extend({
  WALLIE_WORKER_DISPATCH_ENABLED: z.enum(["true", "false"]).default("false"),
  WALLIE_WORKER_AUTH_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().max(100).default(10),
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().max(1_800_000).default(1_800_000),
});
