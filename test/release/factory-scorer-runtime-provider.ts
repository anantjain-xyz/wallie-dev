import assert from "node:assert/strict";

import { z } from "zod/v4";

import { untrustedPromptValue, verifyPromptBoundary } from "@/lib/pipeline/prompt-safety";

import {
  SCORER_FIXTURE_JUDGE_KEY,
  SCORER_FIXTURE_JUDGE_MODEL,
  SCORER_FIXTURE_JUDGE_PROVIDER,
  type FactoryScorerFixtureJudge,
  type FactoryScorerExpectedJudgeInput,
} from "./factory-scorer-runtime-fixture";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const requestBody = z.object({
  model: z.literal(SCORER_FIXTURE_JUDGE_MODEL),
  provider: z.object({
    only: z.tuple([z.literal(SCORER_FIXTURE_JUDGE_PROVIDER)]),
    allow_fallbacks: z.literal(false),
    require_parameters: z.literal(true),
    data_collection: z.literal("deny"),
    zdr: z.literal(true),
  }),
  tool_choice: z.literal("none"),
  stream: z.literal(false),
  response_format: z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      strict: z.literal(true),
      schema: z.object({ properties: z.object({ score: z.unknown() }) }),
    }),
  }),
  messages: z.tuple([
    z.object({ role: z.literal("system"), content: z.string() }),
    z.object({ role: z.literal("user"), content: z.array(textPart) }),
  ]),
});

type PendingResponse = {
  expected: FactoryScorerExpectedJudgeInput;
  outcome: "unavailable" | "pass";
  beforeResponse?: () => Promise<void>;
  inspection: { status: "waiting" | "verified" } | { status: "failed"; error: unknown };
};

/** Fixed HTTP responses preserve the real judge request, parser, and persistence paths. */
export function createFactoryScorerRuntimeProvider() {
  let requests = 0;
  let next: PendingResponse | undefined;
  let failure: { error: unknown } | undefined;
  const judge = {
    respond(
      expected: FactoryScorerExpectedJudgeInput,
      outcome: PendingResponse["outcome"],
      beforeResponse?: () => Promise<void>,
    ) {
      assert(!next, "Exactly one judge response can be scheduled at a time.");
      const scheduled: PendingResponse = {
        expected: { ...expected },
        outcome,
        beforeResponse,
        inspection: { status: "waiting" },
      };
      next = scheduled;
      return () => {
        if (failure) throw failure.error;
        assert(
          scheduled.inspection.status !== "waiting",
          "The qualified judge did not reach the scheduled provider response.",
        );
        if (scheduled.inspection.status === "failed") throw scheduled.inspection.error;
      };
    },
    requestCount: () => requests,
  } satisfies FactoryScorerFixtureJudge;

  function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const originalRequest = typeof input === "string" || input instanceof URL ? undefined : input;
    const url = new URL(originalRequest?.url ?? String(input));
    if (url.href !== endpoint) return undefined;
    requests += 1;
    const sequence = requests;
    const pending = next;
    next = undefined;
    return (async () => {
      try {
        assert(pending, "The scorer reached an unscheduled provider request.");
        assert.equal(init?.method ?? originalRequest?.method, "POST");
        assert.equal(init?.redirect ?? originalRequest?.redirect, "manual");
        const headers = new Headers(init?.headers ?? originalRequest?.headers);
        assert.equal(headers.get("Authorization"), `Bearer ${SCORER_FIXTURE_JUDGE_KEY}`);
        const content =
          init?.body !== undefined
            ? JSON.parse(z.string().parse(init.body))
            : await originalRequest?.json();
        const body = requestBody.parse(content);
        const { expected } = pending;
        const label = JSON.stringify({ kind: "artifact", id: expected.artifactId });
        assert.deepEqual(
          body.messages[1].content,
          [
            {
              type: "text",
              text: verifyPromptBoundary(
                untrustedPromptValue("evaluation.rubric", expected.rubric),
              ),
            },
            {
              type: "text",
              text: `${label}\n${verifyPromptBoundary(untrustedPromptValue("evaluation.evidence.artifact", expected.artifact))}`,
            },
          ],
          "The scorer request must contain the exact pinned rubric and retained artifact.",
        );
        await pending.beforeResponse?.();
        pending.inspection = { status: "verified" };
        if (pending.outcome === "unavailable") return new Response(null, { status: 503 });
        return Response.json({
          model: SCORER_FIXTURE_JUDGE_MODEL,
          provider: SCORER_FIXTURE_JUDGE_PROVIDER,
          id: `gen-local-scorer-${sequence}`,
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  score: true,
                  explanation: "The retained fixture evidence satisfies the pinned rubric.",
                  citations: [
                    { kind: "artifact", id: expected.artifactId, start: null, end: null },
                  ],
                }),
                refusal: null,
              },
            },
          ],
          usage: { prompt_tokens: 31, completion_tokens: 17, total_tokens: 48, cost: 0.001 },
        });
      } catch (error) {
        failure ??= { error };
        if (pending) pending.inspection = { status: "failed", error };
        throw error;
      }
    })();
  }

  return { ...judge, fixtureFetch };
}
