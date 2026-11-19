import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { readFactoryScorerRevision } from "./service";

const workspaceId = "60210000-0000-4000-8000-000000000001";
const factoryId = "60210000-0000-4000-8000-000000000002";
const scorerId = "60210000-0000-4000-8000-000000000003";
const revisionId = "60210000-0000-4000-8000-000000000004";
const scope = { workspaceId, factoryId, scorerId, revisionId };
const revision = {
  id: revisionId,
  scorer_id: scorerId,
  revision_number: 1,
  created_at: "2026-11-19T00:00:00+00:00",
  definition: {
    schemaVersion: 1,
    rubric: "Retain the original historical rubric.",
    requiredEvidence: ["code_diff"],
    scoring: { kind: "boolean", passValue: true },
  },
};

function fixture(fetcher: typeof fetch) {
  return createClient<Database>("http://scorers.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: fetcher },
  });
}

describe("exact scorer revision reads", () => {
  it("loads the historical rubric only when every identity matches", async () => {
    const client = fixture(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/rest/v1/factory_scorer_revisions");
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
      expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
      expect(url.searchParams.get("scorer_id")).toBe(`eq.${scorerId}`);
      expect(url.searchParams.get("id")).toBe(`eq.${revisionId}`);
      return Response.json([revision]);
    });
    await expect(readFactoryScorerRevision(client, scope)).resolves.toEqual(revision);
  });

  it("returns no revision when scope excludes it", async () => {
    const client = fixture(async () => Response.json([]));
    await expect(readFactoryScorerRevision(client, scope)).resolves.toBeNull();
  });

  it("rejects an invalid stored rubric at the read boundary", async () => {
    const client = fixture(async () => Response.json([{ ...revision, definition: {} }]));
    await expect(readFactoryScorerRevision(client, scope)).rejects.toThrow();
  });
});
