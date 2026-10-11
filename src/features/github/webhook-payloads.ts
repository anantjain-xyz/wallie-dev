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
