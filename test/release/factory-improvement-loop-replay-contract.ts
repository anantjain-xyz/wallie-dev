import { z } from "zod";

const gitSha = z.string().regex(/^[a-f0-9]{40}$/);

export const improvementLoopReplayWitness = z.object({
  workspaceId: z.string().uuid(),
  factoryId: z.string().uuid(),
  actorUserId: z.string().uuid(),
  baselineRevisionId: z.string().uuid(),
  candidateRevisionId: z.string().uuid(),
  targetedExperimentId: z.string().uuid(),
  holdoutExperimentId: z.string().uuid(),
  repositoryNumber: z.number().int().positive().safe(),
  upstreamModel: z.string().min(1),
  tasks: z
    .array(
      z.object({
        taskRevisionId: z.string().uuid(),
        prompt: z.string(),
        inputRef: z.string(),
        inputSha: gitSha,
        inputTree: gitSha,
        outputs: z
          .array(
            z.object({
              pass: z.boolean(),
              outputSha: gitSha,
              outputTree: gitSha,
              bundle: z.string(),
              diff: z.string(),
            }),
          )
          .length(2),
      }),
    )
    .length(4),
});

export const improvementLoopFixtureToolchain = {
  image: `vcr.vercel.com/wallie/qualification@sha256:${"d".repeat(64)}`,
  codex: { cliVersion: "0.88.0", cliDigest: "c".repeat(64) },
  opencode: { cliVersion: "1.2.27", cliDigest: "e".repeat(64) },
};

export const improvementLoopFixtureJudge = {
  key: "synthetic-m10-diagnosis-provider-key",
  model: "openai/gpt-4.1-mini",
  provider: "openai",
  costUsd: 0.0125,
};

export const improvementLoopFixtureCostUsd = 0.0625;

export type ImprovementLoopReplayWitness = z.output<typeof improvementLoopReplayWitness>;
