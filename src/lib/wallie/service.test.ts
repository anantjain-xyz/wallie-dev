import { describe, expect, it } from "vitest";

import { claimQueuedJobCandidate } from "@/lib/wallie/service";

describe("wallie service helpers", () => {
  it("claims the first candidate that wins the race", async () => {
    const candidates = [
      { id: "job-1", status: "queued" },
      { id: "job-2", status: "queued" },
      { id: "job-3", status: "queued" },
    ] as const;
    const attempts: string[] = [];

    const claimed = await claimQueuedJobCandidate(candidates, async (job) => {
      attempts.push(job.id);

      if (job.id === "job-1") {
        return null;
      }

      return job;
    });

    expect(attempts).toEqual(["job-1", "job-2"]);
    expect(claimed?.id).toBe("job-2");
  });
});
