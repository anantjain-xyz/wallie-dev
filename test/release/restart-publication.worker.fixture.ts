import { readFile, writeFile } from "node:fs/promises";
import { it, expect, vi } from "vitest";
import { z } from "zod";
import { adminClient, configureTransport, loadProduction } from "./harness";

const manifestSchema = z.object({
  root: z.string().min(1),
  remote: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryNumericId: z.number().int().positive(),
  runId: z.string().uuid(),
  outputPath: z.string().min(1),
});

it("recovers one interrupted publication in a fresh OS process", async () => {
  const path = process.env.WALLIE_CONTINUITY_PUBLICATION_MANIFEST;
  if (!path) throw new Error("Publication recovery requires its isolated fixture manifest.");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const transport = await configureTransport({
    ...manifest,
    run: () => {
      throw new Error("Recovery must use the saved intent without executing the agent again.");
    },
  });
  try {
    const { drainCheckpointPublications } = await loadProduction();
    const admin = adminClient();
    expect(await drainCheckpointPublications(admin, { runId: manifest.runId, limit: 1 })).toEqual({
      adopted: 1,
      failed: 0,
    });
    expect(await drainCheckpointPublications(admin, { runId: manifest.runId, limit: 1 })).toEqual({
      adopted: 0,
      failed: 0,
    });
    expect(transport.runnerStarts).toBe(0);
    await writeFile(manifest.outputPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  } finally {
    vi.unstubAllGlobals();
  }
});
