import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ user: vi.fn(), server: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocks.user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: mocks.upload }));

import { GET as downloadAsset } from "@/app/api/sessions/[sessionId]/validation-evidence/assets/[assetId]/route";
import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { shellQuote } from "@/lib/sandbox/command";
import type { Database } from "@/lib/supabase/database.types";
import type { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";
import { loadArtifactEvidenceLinks } from "./artifact-links";
import { captureValidationEvidence } from "./capture";
import { validationPlanSchema } from "./contracts";
import { persistValidationEvidence } from "./service";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function localSandbox(directory: string): SandboxHandle {
  return {
    id: "evidence-lifetime-fixture",
    repoPath: directory,
    exec: async (command, args, options) => {
      const child = spawn(command, args, {
        cwd: options?.cwd ?? directory,
        env: { ...process.env, ...options?.env },
        signal: options?.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      return {
        exitCode,
        output: async () => {
          await exitCode;
          return { stdout, stderr };
        },
        logs: async function* () {},
        kill: async (signal) => {
          child.kill(signal);
        },
      };
    },
    readFile: async (path) => readFile(path, "utf8").catch(() => null),
    writeFile: async (path, data) => writeFile(path, data),
    stop: async () => {},
  };
}

type Row = Record<string, unknown>;
function database(rows: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let maximum = Infinity;
      const result = () => ({
        data: (rows[table] ?? [])
          .filter((row) => filters.every((filter) => filter(row)))
          .slice(0, maximum),
        error: null,
      });
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return this;
        },
        limit(value: number) {
          maximum = value;
          return this;
        },
        async maybeSingle() {
          const value = result();
          return { ...value, data: value.data[0] ?? null };
        },
        then(resolve: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
    },
  };
}

const manifestSchema = z.array(
  z.object({
    id: z.string().uuid(),
    key: z.string(),
    kind: z.string(),
    required: z.boolean(),
    storagePath: z.string(),
    sha256: z.string(),
    contentType: z.string(),
    sizeBytes: z.number(),
  }),
);

it("opens newly captured private artifact evidence after the entire source checkout is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wallie-artifact-evidence-lifetime-"));
  directories.push(root);
  const source = join(root, "sandbox");
  const storage = join(root, "private-storage");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "source.txt"), "original\n");
  const script = [
    "const fs = require('node:fs');",
    "require('node:assert/strict').equal(fs.readFileSync('source.txt','utf8'),'original\\n');",
    "fs.writeFileSync(process.env.WALLIE_EVIDENCE_DIR+'/review.md','# Review evidence\\n\\nSource assertions passed. fixture-secret-value\\n');",
  ].join("");
  const plan = validationPlanSchema.parse({
    version: 1,
    commands: [
      {
        key: "review",
        command: `node -e ${shellQuote(script)}`,
        timeoutSeconds: 10,
        reports: [{ key: "report", path: "review.md", required: true, kind: "report" }],
      },
    ],
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const commitSha = git("rev-parse", "HEAD");
  const evidence = await captureValidationEvidence({
    sandbox: localSandbox(source),
    commitSha,
    plan,
    secrets: ["fixture-secret-value"],
  });
  expect(evidence.records).toEqual([expect.objectContaining({ status: "passed", commitSha })]);
  const report = evidence.assets.find((asset) => asset.key === "review/report");
  expect(report).toBeDefined();
  if (!report) throw new Error("The harness did not capture the required evidence report.");

  const rows: Record<string, Row[]> = {
    sessions: [{ id: sessionId, workspace_id: workspaceId, archived_at: null }],
    workspace_members: [
      { id: "member", workspace_id: workspaceId, user_id: userId, kind: "human", is_active: true },
    ],
    session_git_checkpoints: [
      {
        artifact_id: artifactId,
        session_id: sessionId,
        workspace_id: workspaceId,
        run_id: runId,
        output_sha: commitSha,
      },
    ],
  };
  mocks.upload.mockImplementation(
    async (_client: unknown, input: Parameters<typeof uploadWorkspaceObject>[1]) => {
      const destination = join(storage, input.bucket, input.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, input.bytes);
      return { error: null };
    },
  );
  const download = vi.fn(async (path: string) => ({
    data: new Blob([
      new Uint8Array(await readFile(join(storage, "session-validation-evidence", path))),
    ]),
    error: null,
  }));
  const client = {
    ...database(rows),
    storage: { from: () => ({ download }) },
    rpc: async (
      name: string,
      input: Database["public"]["Functions"]["record_session_validation_evidence"]["Args"],
    ) => {
      expect(name).toBe("record_session_validation_evidence");
      rows.session_validation_evidence = [
        {
          run_id: input.p_run_id,
          session_id: sessionId,
          workspace_id: workspaceId,
          commit_sha: input.p_commit_sha,
        },
      ];
      rows.session_validation_assets = manifestSchema.parse(input.p_assets).map((asset) => ({
        id: asset.id,
        evidence_key: asset.key,
        run_id: input.p_run_id,
        session_id: sessionId,
        workspace_id: workspaceId,
        storage_path: asset.storagePath,
        content_type: asset.contentType,
        size_bytes: asset.sizeBytes,
        sha256: asset.sha256,
      }));
      return { error: null };
    },
  };
  await persistValidationEvidence({ admin: client as never, workspaceId, runId, evidence });
  await rm(source, { recursive: true });
  await expect(access(source)).rejects.toThrow();

  const links = await loadArtifactEvidenceLinks({
    supabase: client as never,
    sessionId,
    workspaceId,
    artifactId,
  });
  const href = links.get("wallie-evidence:review/report");
  expect(href).toBe(
    `/api/sessions/${sessionId}/validation-evidence/assets/${report.id}?artifactId=${artifactId}`,
  );
  const html = renderMarkdownToHtml(
    "[Review evidence](wallie-evidence:review/report)\n\n[PR description and evidence](/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md)",
    true,
    links,
  );
  expect(html).toContain(`href="${href}"`);
  expect(html).not.toContain('href="/vercel/sandbox');
  expect(html).toContain("Evidence unavailable");
  mocks.user.mockResolvedValue({ id: userId });
  mocks.server.mockResolvedValue(client);
  const request = () => new Request(`https://wallie.test${href}`);
  const context = { params: Promise.resolve({ sessionId, assetId: report.id }) };
  const response = await downloadAsset(request(), context);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("# Review evidence\n\nSource assertions passed. [REDACTED]\n");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");

  mocks.user.mockResolvedValue(null);
  expect((await downloadAsset(request(), context)).status).toBe(401);
  expect(download).toHaveBeenCalledTimes(1);
}, 20_000);
