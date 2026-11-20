import { z } from "zod/v4";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import {
  factoryScorerEvidenceKindSchema,
  type FactoryScorerDefinition,
  type FactoryScorerEvidenceKind,
  type FactoryScorerEvidenceReference,
} from "@/lib/factory-scorers/contracts";
import type { FactoryScorerResult } from "@/lib/factory-scorers/result";

export const MAX_FACTORY_JUDGE_TEXT_BYTES = 96 * 1024;
export const MAX_FACTORY_JUDGE_SCREENSHOT_BYTES = 1024 * 1024;
export const MAX_FACTORY_JUDGE_VIDEO_BYTES = 8 * 1024 * 1024;
export const MAX_FACTORY_JUDGE_DURATION_MS = 30_000;
export const MAX_FACTORY_JUDGE_RESPONSE_BYTES = 64 * 1024;
export const MAX_FACTORY_JUDGE_OUTPUT_TOKENS = 800;

const modelId = z
  .string()
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
export const factoryJudgeProfileSchema = z.strictObject({
  model: modelId.refine((id) => !id.startsWith("openrouter/")),
  provider: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/),
  allowImage: z.boolean(),
  allowVideo: z.boolean(),
});

export type FactoryJudgeProfile = z.infer<typeof factoryJudgeProfileSchema>;

type ExactReference<K extends FactoryScorerEvidenceKind> = FactoryScorerEvidenceReference & {
  kind: K;
};

export type FactoryJudgeEvidence =
  | {
      reference: ExactReference<"artifact" | "code_diff" | "validation_report">;
      mediaType: "text/plain";
      text: string;
    }
  | {
      reference: ExactReference<"browser_screenshot">;
      mediaType: "image/png";
      bytes: Uint8Array;
    }
  | {
      reference: ExactReference<"browser_recording">;
      mediaType: "video/webm";
      bytes: Uint8Array;
      durationMs: number;
    };

export type FactoryJudgeEvidenceLocation = {
  reference: FactoryScorerEvidenceReference;
  location:
    | { kind: "whole" }
    | { kind: "lines"; startLine: number; endLine: number }
    | { kind: "time"; startMs: number; endMs: number };
};

export type FactoryJudgeOutcome = {
  result: FactoryScorerResult;
  judge?: {
    model: string;
    provider?: string;
    requestId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  };
  explanation?: string;
  locations?: FactoryJudgeEvidenceLocation[];
};

const locationIndex = z.number().int().min(0).max(2_147_483_647).nullable();
const citationSchema = z.strictObject({
  kind: z.enum(factoryScorerEvidenceKindSchema.options),
  id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  start: locationIndex,
  end: locationIndex,
});

export function factoryJudgeOutputSchema(scoring: FactoryScorerDefinition["scoring"]) {
  return z.strictObject({
    score: (scoring.kind === "boolean"
      ? z.boolean()
      : z.number().min(scoring.min).max(scoring.max)
    ).nullable(),
    explanation: z.string().min(1).max(640).refine(isFactoryDefinitionText),
    citations: z.array(citationSchema).max(5),
  });
}

const tokenCount = z.number().int().nonnegative().safe().optional().catch(undefined);
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  total_tokens: tokenCount,
  cost: z.number().nonnegative().optional().catch(undefined),
});

export const factoryJudgeProviderMetadataSchema = z.object({
  model: modelId,
  provider: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9 ._/()-]*$/i)
    .optional()
    .catch(undefined),
  id: z
    .string()
    .max(200)
    .regex(/^[a-z0-9_-]+$/i)
    .optional()
    .catch(undefined),
  usage: usageSchema.optional().catch(undefined),
});

export const factoryJudgeProviderOutputSchema = z.object({
  choices: z.tuple([
    z.object({
      finish_reason: z.literal("stop"),
      message: z.object({
        content: z.string().max(MAX_FACTORY_JUDGE_RESPONSE_BYTES),
        refusal: z.null().optional(),
        tool_calls: z.tuple([]).nullable().optional(),
        function_call: z.null().optional(),
      }),
    }),
  ]),
  usage: z
    .object({
      server_tool_use_details: z.object({ tool_calls_executed: z.literal(0).optional() }).nullish(),
    })
    .nullish(),
  error: z.null().optional(),
});

export type FactoryJudgeCitation = z.infer<typeof citationSchema>;
