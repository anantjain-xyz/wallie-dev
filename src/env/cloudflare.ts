import { z } from "zod";

import { workerRunCaptureEnvSchema } from "@/env/worker";

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

export const factoryEventDispatchRelayPath = "/api/internal/factory-event-dispatch";

export const factoryEventDispatchRelayEnvSchema = z.object({
  WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL: optional(
    z.string().refine((value) => {
      const url = URL.parse(value);
      return (
        url?.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !value.includes("?") &&
        !value.includes("#") &&
        url.pathname === factoryEventDispatchRelayPath
      );
    }, "The event dispatch relay must use its fixed HTTPS endpoint."),
  ),
  WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET: optional(z.string().regex(/^[a-zA-Z0-9_-]{43,128}$/)),
});

export const cloudflareEnvSchema = workerWakeEnvSchema.extend({
  ...workerRunCaptureEnvSchema.shape,
  WALLIE_WORKER_DISPATCH_ENABLED: z.enum(["true", "false"]).default("false"),
  WALLIE_WORKER_AUTH_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().max(100).default(10),
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().max(1_800_000).default(1_800_000),
});
