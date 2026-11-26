import { z } from "zod";

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const symptom = z.enum(["scorer", "validation"]);
const disposition = z.enum(["open", "dismissed", "split"]);
const review = z.object({
  revision: count,
  disposition,
  label: z.string().nullable(),
  can_review: z.boolean(),
});

const summary = z.object({
  id,
  task_class_slug: z.string().nullable(),
  agent_id: id,
  symptom_kind: symptom,
  symptom_label: z.string().nullable(),
  failure_count: count,
  support_count: count,
  minimum_support: count,
  version_count: count,
  qualification: z.enum(["qualified", "inconclusive"]),
  qualification_reasons: z.array(
    z.enum(["insufficient_support", "mixed_versions", "missing_evidence", "missing_identity"]),
  ),
  review,
  parent_cohort_id: id.nullable(),
  partition: z.enum(["selected", "remaining"]).nullable(),
  split_cohort_ids: z.array(id),
});

const evidenceState = z.enum(["available", "withheld", "unavailable"]);
const cohortMember = z.object({
  id,
  run_id: id,
  session_id: id,
  run_attempt_count: z.number().int().positive(),
  session_title: z.string().nullable(),
  session_number: count.nullable(),
  stage_name: z.string().nullable(),
  observed_at: z.string().datetime({ offset: true }),
  configuration: z.object({
    definition_revision_id: id.nullable(),
    execution_revision_id: id.nullable(),
    agent_id: id,
    agent_prompt_revision_id: id,
    model_provider: z.string(),
    model_name: z.string(),
  }),
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("scorer"),
      evaluation_job_id: id,
      evaluation_attempt_id: id,
      scorer_revision_id: id,
      evidence_state: evidenceState,
    }),
    z.object({
      kind: z.literal("validation"),
      validation_run_id: id,
      validation_record_key: z.string().nullable(),
      target_commit_sha: z.string().nullable(),
      target_tree_sha: z.string().nullable(),
      evidence_state: evidenceState,
    }),
  ]),
});

export const failureCohortListSchema = z.object({
  cohorts: z.array(summary),
  next_cohort_id: id.nullable(),
  cursor_unavailable: z.boolean(),
});

export const failureCohortDetailSchema = z.object({
  cohort: summary,
  members: z.array(cohortMember),
  next_member_id: id.nullable(),
  membership_digest: digest.nullable(),
  split_groups: z.array(z.object({ id, side: z.enum(["selected", "remaining"]) })),
});

const filterFields = z.object({
  symptom: symptom.optional(),
  revision: id.optional(),
  disposition: disposition.optional(),
  after: id.optional(),
  order: z.literal("failures").optional(),
});

type SearchParams = Record<string, string | string[] | undefined>;

export function parseFailureCohortQuery(query: SearchParams) {
  return filterFields.safeParse({
    symptom: query.symptom || undefined,
    revision: query.revision || undefined,
    disposition: query.disposition || undefined,
    after: query.after || undefined,
    order: query.order || undefined,
  });
}

export function parseFailureCohortEvidenceQuery(query: SearchParams) {
  return z
    .object({
      runSearch: z.string().trim().max(120).optional(),
      observedOn: z.string().date().optional(),
    })
    .safeParse({
      runSearch: query.runSearch || undefined,
      observedOn: query.observedOn || undefined,
    });
}

export const failureRevisionOptionSchema = z.object({
  id,
  label: z.string(),
  detail: z.string(),
});

export const failureRevisionPageSchema = z.object({
  options: z.array(failureRevisionOptionSchema),
  next: id.nullable(),
});

const reviewFields = {
  expectedRevision: count.max(2_147_483_647),
  requestId: id,
};

export const maxFailureCohortSplitRuns = 100;

export const failureCohortReviewSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...reviewFields,
    action: z.literal("label"),
    label: z.string().trim().min(1).max(120),
  }),
  z.strictObject({ ...reviewFields, action: z.literal("dismiss") }),
  z.strictObject({
    ...reviewFields,
    action: z.literal("split"),
    membershipDigest: digest,
    selectedRunIds: z
      .array(id)
      .min(1)
      .max(maxFailureCohortSplitRuns)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);

export const failureCohortReviewResultSchema = z.object({
  review,
  split_cohort_ids: z.array(id),
});

export const failureCohortIdSchema = id;
export type FailureCohortQuery = z.infer<typeof filterFields>;
export type FailureCohortSummary = z.infer<typeof summary>;
export type FailureCohortMember = z.infer<typeof cohortMember>;
export type FailureCohortDetail = z.infer<typeof failureCohortDetailSchema>;
export type FailureCohortReview = z.infer<typeof failureCohortReviewSchema>;
export type FailureRevisionOption = z.infer<typeof failureRevisionOptionSchema>;
export type FailureRevisionPage = z.infer<typeof failureRevisionPageSchema>;
