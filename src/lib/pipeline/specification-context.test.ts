import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadSpecificationPromptContext } from "./specification-context";

it("retains older answers and the exact prior draft without carrying its control directive", async () => {
  const requests: URL[] = [];
  const savedSpecification =
    "`{{attempt.feedback}}`\n" +
    "😀".repeat(12_001) +
    "\n## Acceptance criteria\nThe administrator can change the workspace role.";
  const previousDraft =
    '<!-- wallie-clarification: {"question":"Current question"} -->\r\n' + savedSpecification;
  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        if (init?.method === "HEAD") {
          return new Response(null, { headers: { "content-range": "*/3" } });
        }
        if (url.pathname.endsWith("session_specification_clarifications")) {
          return Response.json([
            { ordinal: 1, question: "Which identity provider?", answer_text: "Workspace." },
            { ordinal: 2, question: "Which role?", answer_text: "Administrator." },
          ]);
        }
        return Response.json([{ artifact_json: previousDraft }]);
      },
    },
  });

  const result = await loadSpecificationPromptContext(
    admin,
    {
      id: "session-id",
      workspace_id: "workspace-id",
      factory_id: "factory-id",
      current_artifact_id: "artifact-three",
      current_artifact_version: 3,
    },
    "stage-id",
  );

  expect(result.canAskClarification).toBe(false);
  expect(result.clarificationHistory).toMatchObject({
    source: "specification.clarificationHistory",
    trust: "untrusted",
    value:
      "Round 1\nQuestion: Which identity provider?\nAnswer: Workspace.\n\n" +
      "Round 2\nQuestion: Which role?\nAnswer: Administrator.",
  });
  expect(result.priorDraft).toMatchObject({
    source: "specification.priorDraft",
    trust: "untrusted",
    value: savedSpecification,
  });

  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.searchParams.get("workspace_id")).toBe("eq.workspace-id");
    expect(request.searchParams.get("session_id")).toBe("eq.session-id");
    expect(request.searchParams.get("stage_id")).toBe("eq.stage-id");
  }
  const count = requests.find((request) => request.searchParams.get("select") === "id");
  expect(count?.searchParams.get("factory_id")).toBe("eq.factory-id");
  const history = requests.find((request) => request.searchParams.has("artifact_version"));
  expect(history?.searchParams.get("factory_id")).toBe("eq.factory-id");
  expect(history?.searchParams.get("status")).toBe("eq.answered");
  expect(history?.searchParams.get("artifact_version")).toBe("lt.3");
  expect(history?.searchParams.get("order")).toBe("ordinal.asc");
  expect(history?.searchParams.get("limit")).toBe("3");
  const draft = requests.find((request) => request.pathname.endsWith("session_artifacts"));
  expect(draft?.searchParams.get("id")).toBe("eq.artifact-three");
  expect(draft?.searchParams.get("session.factory_id")).toBe("eq.factory-id");
  expect(draft?.searchParams.get("version")).toBe("eq.3");
});
