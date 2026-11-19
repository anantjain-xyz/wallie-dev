import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readSandboxBoundedTextFile } from "@/lib/sandbox/bounded-text-file";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

import { stageFactoryMemoryProposal } from "./proposal";

vi.mock("@/lib/sandbox/bounded-text-file", () => ({ readSandboxBoundedTextFile: vi.fn() }));

const read = vi.mocked(readSandboxBoundedTextFile);
const artifactMarkdown = "Published artefact with its exact newline.\n";
const note = "An observed project convention.";
const sandbox = {} as SandboxHandle;
const scope = {
  sandbox,
  workspaceId: "workspace-1",
  jobId: "job-2",
  runId: "run-3",
  attemptCount: 2,
  artifactMarkdown,
  secrets: ["fixture-secret-content"],
};

function database(accepted: boolean) {
  const calls: unknown[] = [];
  const admin = createClient<Database>("https://database.example.test", "service-fixture", {
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toMatch(/\/rpc\/stage_factory_run_memory_proposal$/);
        calls.push(JSON.parse(String(init?.body)));
        return Response.json(accepted);
      },
    },
  });
  return { admin, calls };
}

beforeEach(() => read.mockReset());

describe("run-owned memory proposals", () => {
  it("stages a note from the bounded private path against the exact run and artifact digest", async () => {
    read.mockResolvedValue(`\n${note}\n`);
    const { admin, calls } = database(true);
    await stageFactoryMemoryProposal({ ...scope, admin });
    expect(read).toHaveBeenCalledWith({
      sandbox,
      path: "/tmp/wallie-memory-proposal-run-3.md",
      maxBytes: 4096,
      signal: undefined,
    });
    expect(calls).toEqual([
      {
        p_workspace_id: scope.workspaceId,
        p_job_id: scope.jobId,
        p_run_id: scope.runId,
        p_attempt_count: scope.attemptCount,
        p_artifact_sha256: createHash("sha256").update(artifactMarkdown).digest("hex"),
        p_body_md: note,
      },
    ]);
  });

  it.each([
    null,
    " ",
    "fixture-secret-content",
    "Authorization: Bearer fixture-token",
    "é".repeat(2049),
  ])("omits an absent, invalid or sensitive note", async (text) => {
    read.mockResolvedValue(text);
    const { admin, calls } = database(true);
    await stageFactoryMemoryProposal({ ...scope, admin });
    expect(calls).toEqual([]);
  });

  it("stops on a rejected ownership or body claim without revealing the note", async () => {
    read.mockResolvedValue(note);
    const { admin } = database(false);
    await expect(stageFactoryMemoryProposal({ ...scope, admin })).rejects.toThrow(
      "The factory memory proposal could not be associated with its producing run.",
    );
  });

  it("does not stage a separate copy of a note in the published artifact", async () => {
    read.mockResolvedValue(note);
    const { admin, calls } = database(true);
    await stageFactoryMemoryProposal({ ...scope, admin, artifactMarkdown: `# Review\n\n${note}` });
    expect(calls).toEqual([]);
  });
});
