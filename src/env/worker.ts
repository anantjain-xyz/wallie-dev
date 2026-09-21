import { z } from "zod";

export const workerControlEnvSchema = z.object({
  WORKER_CONTROL_SOCKET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .startsWith("/", "WORKER_CONTROL_SOCKET must be an absolute Unix socket path")
      .refine((value) => Buffer.byteLength(value) <= 100 && !value.includes("\0"), {
        message: "WORKER_CONTROL_SOCKET must contain at most 100 bytes and no NUL characters",
      })
      .optional(),
  ),
});
