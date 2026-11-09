import { z } from "zod";

const evidenceKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const reportSchema = z
  .object({
    key: evidenceKey,
    path: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.split("/").some((part) => ["", ".", ".."].includes(part)) &&
          !/[\\\x00-\x1f]/.test(value),
      ),
    kind: z.enum(["report", "screenshot", "preview"]),
    required: z.boolean(),
  })
  .strict();

/** Execution instructions frozen on one run, never an assertion that checks passed. */
export const validationPlanSchema = z
  .object({
    version: z.literal(1),
    commands: z
      .array(
        z
          .object({
            key: evidenceKey,
            command: z.string().min(1).max(4096),
            timeoutSeconds: z.number().int().min(1).max(300),
            reports: z.array(reportSchema).max(10).default([]),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((config, context) => {
    const keys = config.commands.map((command) => command.key);
    const assetKeys = config.commands.flatMap((command) => [
      `${command.key}/log`,
      ...command.reports.map((report) => `${command.key}/${report.key}`),
    ]);
    if (
      new Set(keys).size !== keys.length ||
      new Set(assetKeys).size !== assetKeys.length ||
      assetKeys.length > 100 ||
      assetKeys.some((key) => key.length > 200)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Evidence identities must be unique and bounded.",
      });
    }
  });

export type ValidationPlan = z.infer<typeof validationPlanSchema>;
export type ValidationEvidenceRecord = {
  key: string;
  command: string;
  provenance: "harness";
  status: "passed" | "failed" | "stale" | "error";
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  commitSha: string | null;
  treeSha: string | null;
  finalCommitSha: string | null;
  finalTreeSha: string | null;
  reportKeys: string[];
  missingRequiredReports: string[];
};

export type ValidationEvidenceAsset = {
  id: string;
  key: string;
  kind: "report" | "screenshot" | "preview" | "log";
  required: boolean;
  bytes: Buffer;
  contentType: string;
};

export type CapturedValidationEvidence = {
  commitSha: string;
  treeSha: string;
  records: ValidationEvidenceRecord[];
  assets: ValidationEvidenceAsset[];
};
