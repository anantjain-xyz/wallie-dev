import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { maintainFactoryEvaluationQueue } from "./maintenance";

const counts = {
  receipts_processed: 5,
  jobs_admitted: 3,
  attempts_recovered: 4,
  jobs_requeued: 3,
  jobs_failed: 1,
};

it("runs one bounded Node maintenance batch against the evaluation RPC", async () => {
  const fetchBatch = vi.fn<typeof fetch>(async () => Response.json(counts));
  const admin = createClient<Database>("https://evaluation.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchBatch },
  });

  await expect(maintainFactoryEvaluationQueue(admin)).resolves.toEqual(counts);
  expect(fetchBatch).toHaveBeenCalledExactlyOnceWith(
    "https://evaluation.example.test/rest/v1/rpc/maintain_factory_evaluation_queue",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ p_limit: 25 }) }),
  );
});

it("fails the maintenance task on an inconsistent RPC result", async () => {
  const admin = createClient<Database>("https://evaluation.example.test", "test-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: async () => Response.json({ ...counts, jobs_failed: 0 }) },
  });

  await expect(maintainFactoryEvaluationQueue(admin)).rejects.toThrow(
    "Could not maintain the factory evaluation queue.",
  );
});
