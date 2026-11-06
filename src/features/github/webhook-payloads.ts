import { z } from "zod";

const githubId = z.number().int().positive().safe();

export const installationEventSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ id: githubId }),
});

export const pullRequestEventSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ id: githubId }).optional(),
  pull_request: z.object({
    draft: z.boolean(),
    head: z.object({
      ref: z.string().min(1),
      // GitHub may omit or null a deleted head repository. Known PR identities
      // still reconcile, but branch fallback requires positive same-repo proof.
      repo: z.object({ id: githubId }).nullable().optional(),
    }),
    html_url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:"),
    merged: z.boolean(),
    number: z.number().int().positive().max(2_147_483_647),
    state: z.enum(["closed", "open"]),
    updated_at: z.string().datetime({ offset: true }),
  }),
  repository: z.object({ id: githubId }),
});

export type InstallationEventPayload = z.infer<typeof installationEventSchema>;
export type PullRequestEventPayload = z.infer<typeof pullRequestEventSchema>;

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const prNumber = z.number().int().positive().max(2_147_483_647);
const verificationIdentity = z.object({
  installation: z.object({ id: githubId }).optional(),
  repository: z.object({ id: githubId }),
});

/** Webhook bodies are wake-ups, never authoritative verification receipts. */
export type GitHubVerificationSignal = {
  installationId?: number;
  repositoryId: number;
  prNumbers?: number[];
  headSha?: string;
  baseBranch?: string;
};

const prSignal = verificationIdentity
  .extend({ pull_request: z.object({ number: prNumber }) })
  .transform(
    (payload): GitHubVerificationSignal => ({
      installationId: payload.installation?.id,
      repositoryId: payload.repository.id,
      prNumbers: [payload.pull_request.number],
    }),
  );
const check = z.object({
  head_sha: sha,
  pull_requests: z.array(z.object({ number: prNumber })).max(100),
});
const checkSignal = (
  payload: z.infer<typeof verificationIdentity>,
  source: z.infer<typeof check>,
): GitHubVerificationSignal => ({
  installationId: payload.installation?.id,
  repositoryId: payload.repository.id,
  headSha: source.head_sha,
  prNumbers: source.pull_requests.map((pr) => pr.number),
});

export const verificationEventPayloadSchemas = {
  pull_request: prSignal,
  pull_request_review: prSignal,
  pull_request_review_comment: prSignal,
  pull_request_review_thread: prSignal,
  check_run: verificationIdentity
    .extend({ check_run: check })
    .transform((payload) => checkSignal(payload, payload.check_run)),
  check_suite: verificationIdentity
    .extend({ check_suite: check })
    .transform((payload) => checkSignal(payload, payload.check_suite)),
  status: verificationIdentity.extend({ sha }).transform(
    (payload): GitHubVerificationSignal => ({
      installationId: payload.installation?.id,
      repositoryId: payload.repository.id,
      headSha: payload.sha,
    }),
  ),
  push: verificationIdentity.extend({ ref: z.string().min(1).max(1100) }).transform(
    (payload): GitHubVerificationSignal => ({
      installationId: payload.installation?.id,
      repositoryId: payload.repository.id,
      // Tags cannot change a canonical PR's target branch.
      baseBranch: payload.ref.startsWith("refs/heads/") ? payload.ref.slice(11) : undefined,
    }),
  ),
};

export type GitHubVerificationEventName = keyof typeof verificationEventPayloadSchemas;

export function isGitHubVerificationEvent(
  event: string | null,
): event is GitHubVerificationEventName {
  return event !== null && Object.hasOwn(verificationEventPayloadSchemas, event);
}

export const githubDeliveryIdSchema = z.string().uuid();
