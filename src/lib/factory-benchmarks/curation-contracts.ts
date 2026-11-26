import { z } from "zod";

const id = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const tag = z.string().trim().min(1);
const revision = { revisionId: id, revisionNumber: z.number().int().positive() };

const suiteFields = {
  name,
  purpose: z.enum(["regression", "holdout"]),
  allowEmpty: z.literal(true).optional(),
  selection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("explicit"), taskRevisionIds: z.array(id) }).strict(),
    z
      .object({
        kind: z.literal("tags"),
        tags: z.array(tag).min(1),
        previewTaskRevisionIds: z.array(id).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("preserve") }).strict(),
  ]),
};

export const saveBenchmarkSuiteSchema = z
  .union([
    z
      .object({
        ...suiteFields,
        suiteId: z.never().optional(),
        expectedRevisionId: z.never().optional(),
      })
      .strict(),
    z.object({ ...suiteFields, suiteId: id, expectedRevisionId: id }).strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.selection.kind === "preserve" && !command.suiteId) {
      ctx.addIssue({
        code: "custom",
        path: ["selection"],
        message: "Choose a task selection for a new suite.",
      });
    }
  });

export const saveBenchmarkTaskSchema = z
  .object({
    taskId: id,
    expectedRevisionId: id,
    name,
    acceptanceCriteria: z.string().trim().min(1).max(20_000),
    tags: z.array(tag),
  })
  .strict();

export const benchmarkSuiteMutationResultSchema = z.object({ suiteId: id, ...revision });
export const benchmarkTaskMutationResultSchema = z.object({ taskId: id, ...revision });

export type SaveBenchmarkSuite = z.infer<typeof saveBenchmarkSuiteSchema>;
export type SaveBenchmarkTask = z.infer<typeof saveBenchmarkTaskSchema>;
export type BenchmarkSuiteMutationResult = z.infer<typeof benchmarkSuiteMutationResultSchema>;
export type BenchmarkTaskMutationResult = z.infer<typeof benchmarkTaskMutationResultSchema>;
