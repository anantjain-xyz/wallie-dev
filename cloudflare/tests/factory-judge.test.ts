import { expect, it, vi } from "vitest";

import { runFactoryJudge } from "@/lib/factory-evaluations/judge";

const artifactId = "73400000-0000-4000-8000-000000000001";
const model = "openai/gpt-4.1-mini";
const apiKey = "synthetic-local-judge-key";

function judge(fetcher: typeof fetch) {
  return runFactoryJudge({
    definition: {
      schemaVersion: 1,
      rubric: "Confirm the retained artifact meets the acceptance conditions.",
      requiredEvidence: ["artifact"],
      scoring: { kind: "boolean", passValue: true },
    },
    evidence: [
      {
        reference: { kind: "artifact", id: artifactId },
        mediaType: "text/plain",
        text: "The retained artifact meets the acceptance conditions.",
      },
    ],
    profile: { model, provider: "openai", allowImage: false, allowVideo: false },
    apiKey,
    signal: new AbortController().signal,
    fetcher,
  });
}

it("constructs a native Workerd request and accepts the fixed judge response", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const request = new Request(input, options);
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    return Response.json({
      model,
      provider: "openai",
      id: "gen-workerd-judge-fixture",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              score: true,
              explanation: "The retained evidence meets the rubric.",
              citations: [{ kind: "artifact", id: artifactId, start: null, end: null }],
            }),
            refusal: null,
          },
        },
      ],
    });
  });

  expect(await judge(fetcher)).toMatchObject({ result: { status: "pass" } });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("rejects a redirect after one native request without fetching its destination", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const request = new Request(input, options);
    expect(request.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://redirect.example.test/" },
    });
  });

  expect(await judge(fetcher)).toMatchObject({
    result: { status: "error", reason: "provider_unavailable" },
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
