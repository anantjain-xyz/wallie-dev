import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { drainRunRetention } from "./maintenance";

const path =
  "53800000-0001-4000-8000-000000000001/53800000-0005-4000-8000-000000000001/53800000-0006-4000-8000-000000000001";

it("retries the exact object after a Storage failure and acknowledges only the current lease", async () => {
  let removeFailed = false;
  let completed = false;
  let claimNumber = 0;
  const removals: string[][] = [];
  const acknowledgements: string[][] = [];

  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const endpoint = url.pathname.split("/").at(-1);
        switch (endpoint) {
          case "mark_expired_workspace_run_content":
            return Response.json([{ transcripts_expired: 0, evidence_expired: 0 }]);
          case "purge_expired_run_transcripts":
          case "purge_expired_factory_memory_bodies":
            return Response.json(0);
          case "claim_run_evidence_purges":
            return Response.json(
              completed ? [] : [{ storage_path: path, claim_id: `claim-${++claimNumber}` }],
            );
          case "session-validation-evidence": {
            expect(init?.method).toBe("DELETE");
            removals.push(JSON.parse(String(init?.body)).prefixes);
            if (!removeFailed) {
              removeFailed = true;
              return Response.json({ message: "Storage unavailable" }, { status: 503 });
            }
            // A previous worker may have removed the object before losing its
            // acknowledgement. Supabase treats removal of an absent path as success.
            return Response.json([]);
          }
          case "complete_run_evidence_purges":
            acknowledgements.push(JSON.parse(String(init?.body)).p_claim_ids);
            completed = true;
            return Response.json(1);
          default:
            throw new Error(`Unexpected request ${url.pathname}`);
        }
      },
    },
  });

  await expect(drainRunRetention(admin)).rejects.toThrow("Storage unavailable");
  expect(acknowledgements).toEqual([]);
  await expect(drainRunRetention(admin)).resolves.toMatchObject({ evidencePurged: 1 });
  await expect(drainRunRetention(admin)).resolves.toMatchObject({ evidencePurged: 0 });
  expect(removals).toEqual([[path], [path]]);
  expect(acknowledgements).toEqual([["claim-2"]]);
});
