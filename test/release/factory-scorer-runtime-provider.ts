import assert from "node:assert/strict";

import { z } from "zod/v4";

import {
  SCORER_FIXTURE_JUDGE_KEY,
  SCORER_FIXTURE_JUDGE_MODEL,
  SCORER_FIXTURE_JUDGE_PROVIDER,
  type FactoryScorerFixtureJudge,
} from "./factory-scorer-runtime-fixture";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const evidenceLabel = z.strictObject({
  kind: z.enum(["artifact", "validation_report", "code_diff"]),
  id: z.uuid(),
});
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
  outcome: "unavailable" | "pass";
  beforeResponse: () => Promise<void>;
};

/** Fixed HTTP responses preserve the real judge request, parser, and persistence paths. */
export function createFactoryScorerRuntimeProvider() {
  let requests = 0;
  let next: PendingResponse | undefined;
  const judge = {
    respondAfter(outcome: PendingResponse["outcome"], beforeResponse: () => Promise<void>) {
      assert(!next, "Exactly one judge response can be scheduled at a time.");
      let inspection: { ok: true } | { ok: false; error: unknown } | undefined;
      next = {
        outcome,
        async beforeResponse() {
          try {
            await beforeResponse();
            inspection = { ok: true };
          } catch (error) {
            inspection = { ok: false, error };
          }
        },
      };
      return () => {
        assert(inspection, "The qualified judge did not reach the scheduled provider response.");
        if (!inspection.ok) throw inspection.error;
      };
    },
    requestCount: () => requests,
  } satisfies FactoryScorerFixtureJudge;

  function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const originalRequest = typeof input === "string" || input instanceof URL ? undefined : input;
    const url = new URL(originalRequest?.url ?? String(input));
    if (url.href !== endpoint) return undefined;
    return (async () => {
      assert.equal(init?.method ?? originalRequest?.method, "POST");
      assert.equal(init?.redirect ?? originalRequest?.redirect, "manual");
      const headers = new Headers(init?.headers ?? originalRequest?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${SCORER_FIXTURE_JUDGE_KEY}`);
      const content =
        init?.body !== undefined
          ? JSON.parse(z.string().parse(init.body))
          : await originalRequest?.json();
      const body = requestBody.parse(content);
      const citations = body.messages[1].content.flatMap(({ text }) => {
        const firstLine = text.split("\n", 1)[0];
        let label: unknown;
        try {
          label = JSON.parse(firstLine);
        } catch {
          return [];
        }
        const result = evidenceLabel.safeParse(label);
        return result.success && result.data.kind === "artifact"
          ? [{ ...result.data, start: null, end: null }]
          : [];
      });
      assert(citations.length > 0, "The scorer request must include exact retained text evidence.");
      requests += 1;
      const sequence = requests;
      const pending = next;
      next = undefined;
      await pending?.beforeResponse();
      if (pending?.outcome === "unavailable") return new Response(null, { status: 503 });
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
                citations,
              }),
              refusal: null,
            },
          },
        ],
        usage: { prompt_tokens: 31, completion_tokens: 17, total_tokens: 48, cost: 0.001 },
      });
    })();
  }

  return { ...judge, fixtureFetch };
}
