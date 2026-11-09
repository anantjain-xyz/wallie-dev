import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { AgentEvent, AgentRunnerStartInput } from "@/lib/agent-runner/types";
import type { CreateSessionSandboxInput } from "@/lib/sandbox/types";
import type { GitExecutor, SourceGitWorkspace } from "@/lib/pipeline/source-delivery-git-core";

const seams = vi.hoisted(() => ({
  runner: vi.fn(),
  sandbox: vi.fn(),
  utility: vi.fn(),
  restore: vi.fn(),
  token: vi.fn(),
}));
vi.mock("@/lib/agent-runner", async (original) => ({
  ...(await original<typeof import("@/lib/agent-runner")>()),
  createAgentRunner: seams.runner,
}));
vi.mock("@/lib/sandbox", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox")>()),
  createSessionSandbox: seams.sandbox,
}));
vi.mock("@/lib/pipeline/source-delivery-sandbox", async (original) => ({
  ...(await original<typeof import("@/lib/pipeline/source-delivery-sandbox")>()),
  withSourceGitSandbox: seams.utility,
  restoreAndPushSourceInSandbox: seams.restore,
}));
vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: seams.token }));

const exec = promisify(execFile);
export type Admin = SupabaseClient<Database>;
export type ReleaseState = {
  enabled: boolean;
  revision: number;
  reason: string;
  updated_at: string;
};
export type Manifest = {
  root: string;
  remote: string;
  repositoryName: string;
  repositoryNumericId: number;
  workspaceId: string;
  sessionId: string;
  jobId: string;
  expectedSha: string;
  expectedFiles: Record<string, string>;
  outputPath: string;
};
type ProviderPr = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string; repo: { id: number; full_name: string } };
  base: { ref: string; repo: { id: number; full_name: string } };
};

export function adminClient(): Admin {
  const url = process.env.WALLIE_CONTINUITY_SUPABASE_URL;
  const key = process.env.WALLIE_CONTINUITY_SERVICE_ROLE_KEY;
  assert(url && key, "Run through scripts/check-continuity.ts with an isolated local stack.");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "Local DB only.");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function checked<Query extends PromiseLike<{ data: unknown; error: unknown }>>(
  query: Query,
): Promise<NonNullable<Awaited<Query>["data"]>> {
  const { data, error } = await query;
  if (error) throw error;
  // PostgREST single() reports absent rows as errors; writes without a return
  // representation may yield null, and their callers deliberately ignore it.
  return data as NonNullable<Awaited<Query>["data"]>;
}

export async function rpc<T>(
  admin: Admin,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const call = admin.rpc.bind(admin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: T; error: unknown }>;
  return checked(call(name, args));
}

export async function releaseState(admin: Admin): Promise<ReleaseState> {
  const rows = await rpc<ReleaseState[]>(admin, "get_git_continuity_release_state");
  assert(rows[0], "Continuity release migration must be installed.");
  return rows[0];
}

export async function setRelease(
  admin: Admin,
  enabled: boolean,
  reason: string,
): Promise<ReleaseState> {
  const current = await releaseState(admin);
  const rows = await rpc<ReleaseState[]>(admin, "set_git_continuity_release", {
    p_enabled: enabled,
    p_expected_revision: current.revision,
    p_reason: reason,
  });
  assert(rows[0], "Continuity release CAS must succeed in the isolated fixture.");
  return rows[0];
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function claimJob(admin: Admin, expectedJobId: string): Promise<Tables<"agent_jobs">> {
  const rows = await rpc<Tables<"agent_jobs">[]>(admin, "claim_next_agent_job", {
    default_concurrency_limit: 4,
  });
  assert.equal(rows[0]?.id, expectedJobId, "Isolated fixture must claim its expected queued job.");
  return rows[0];
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Local adapters replace external transport only; pipeline and Git algorithms remain real. */
export async function configureTransport(input: {
  root: string;
  remote: string;
  repositoryName: string;
  repositoryNumericId: number;
  run: (input: AgentRunnerStartInput) => AsyncIterable<AgentEvent>;
}) {
  const { FakeSandbox } = await import("@/lib/sandbox/fake");
  const { checkoutSandboxCheckpoint } = await import("@/lib/sandbox/checkout");
  const { restoreAndPushSourceWithWorkspace } =
    await import("@/lib/pipeline/source-delivery-git-core");
  const state = {
    blockedCheckpointPush: false,
    blockedCanonicalPush: false,
    prs: [] as ProviderPr[],
    createCount: 0,
    runnerStarts: 0,
    sandboxes: [] as InstanceType<typeof FakeSandbox>[],
    initialHeads: [] as string[],
  };
  const canonicalUrl = `https://github.com/${input.repositoryName}.git`;
  const dependencies = () => ({
    execGit: (async (args, options) => {
      const mapped = args.map((arg) => {
        if (arg === canonicalUrl) return input.remote;
        assert(!/^(?:https?|ssh|git):\/\//.test(arg), "No live Git transport is allowed.");
        return arg;
      });
      if (args[0] === "push") {
        if (
          state.blockedCheckpointPush &&
          args.some((arg) => arg.includes(":refs/wallie/checkpoints/"))
        )
          throw new Error("Controlled checkpoint transport outage.");
        if (
          state.blockedCanonicalPush &&
          args.some((arg) => arg.includes(":refs/heads/wallie/sessions/"))
        )
          throw new Error("Controlled canonical transport outage.");
      }
      return exec("git", mapped, { ...options, encoding: "utf8" });
    }) satisfies GitExecutor,
    createWorkspace: async (): Promise<SourceGitWorkspace> => {
      const path = await mkdtemp(join(input.root, "trusted-git-"));
      return {
        path,
        writeBundle: (bytes) => writeFile(join(path, "source.bundle"), bytes, { mode: 0o600 }),
        close: () => rm(path, { recursive: true, force: true }),
      };
    },
  });
  seams.utility.mockImplementation(async (_signal, _context, execute) => execute(dependencies()));
  seams.restore.mockImplementation(async (restoreInput) =>
    restoreAndPushSourceWithWorkspace(restoreInput, dependencies()),
  );
  seams.runner.mockImplementation(() => ({
    provider: "codex",
    requiresSandbox: true,
    start: async function* (start: AgentRunnerStartInput) {
      state.runnerStarts++;
      assert(start.sandbox, "Runner must receive a real local sandbox.");
      state.initialHeads.push(await git(start.sandbox.repoPath, "rev-parse", "HEAD"));
      yield* input.run(start);
    },
  }));
  seams.token.mockImplementation(async ({ purpose }) =>
    purpose === "checkout" ? "fixture-checkout-read-token" : "fixture-trusted-publisher-token",
  );
  seams.sandbox.mockImplementation(async (request: CreateSessionSandboxInput) => {
    assert.equal(request.implementation, "fake");
    assert.equal(request.repoFullName, input.repositoryName);
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    state.sandboxes.push(sandbox);
    try {
      await git(sandbox.repoPath, "remote", "add", "origin", input.remote);
      if (request.mode?.kind === "checkpoint") {
        await checkoutSandboxCheckpoint({
          sandbox,
          branch: request.branch,
          checkpoint: request.mode,
          signal: request.signal,
        });
      } else {
        await git(sandbox.repoPath, "fetch", "--depth=1", "origin", request.baseBranch);
        await git(sandbox.repoPath, "checkout", "-B", request.branch, "FETCH_HEAD");
      }
      await request.onSandboxCreated?.({ provider: "fake", sandboxId: sandbox.id });
      return sandbox;
    } catch (error) {
      await sandbox.stop();
      throw error;
    }
  });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (request: string | URL | Request, options?: RequestInit) => {
    const url = new URL(
      typeof request === "string" || request instanceof URL ? request : request.url,
    );
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return originalFetch(request, options);
    assert.equal(
      url.origin,
      "https://api.github.com",
      "Only loopback requests or in-process GitHub fixtures are allowed.",
    );
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("Authorization"), "Bearer fixture-trusted-publisher-token");
    const prefix = `/repos/${input.repositoryName}`;
    assert(
      url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
      "GitHub fixture repository scope must match.",
    );
    const metadata = { id: input.repositoryNumericId, full_name: input.repositoryName };
    if (url.pathname === prefix) return Response.json(metadata);
    if (url.pathname === `${prefix}/pulls` && options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as {
        title: string;
        head: string;
        base: string;
      };
      assert(body.title);
      const headSha = await git(input.remote, "rev-parse", `refs/heads/${body.head}`);
      const pr: ProviderPr = {
        number: state.prs.length + 1,
        html_url: `https://github.com/${input.repositoryName}/pull/${state.prs.length + 1}`,
        state: "open",
        draft: false,
        merged_at: null,
        updated_at: new Date().toISOString(),
        head: { ref: body.head, sha: headSha, repo: metadata },
        base: { ref: body.base, repo: metadata },
      };
      state.prs.push(pr);
      state.createCount++;
      return Response.json(pr, { status: 201 });
    }
    if (url.pathname === `${prefix}/pulls`) {
      assert.equal(url.searchParams.get("state"), "all");
      const branch = url.searchParams.get("head")?.split(":").slice(1).join(":");
      return Response.json(state.prs.filter((pr) => pr.head.ref === branch));
    }
    const number = /^\/pulls\/(\d+)$/.exec(url.pathname.slice(prefix.length))?.[1];
    assert(number, "Unsupported GitHub fixture endpoint.");
    const pr = state.prs.find((row) => row.number === Number(number));
    if (!pr) return Response.json({ message: "Not Found" }, { status: 404 });
    pr.head.sha = await git(input.remote, "rev-parse", `refs/heads/${pr.head.ref}`);
    pr.updated_at = new Date().toISOString();
    return Response.json(pr);
  });
  return state;
}

export async function loadProduction() {
  const [processor, service, checkpoint, canonical] = await Promise.all([
    import("@/lib/pipeline/processor"),
    import("@/lib/wallie/service"),
    import("@/lib/pipeline/checkpoint-publication"),
    import("@/lib/pipeline/canonical-pr-publisher"),
  ]);
  return { ...processor, ...service, ...checkpoint, ...canonical };
}

export async function readManifest(): Promise<Manifest> {
  const path = process.env.WALLIE_CONTINUITY_RESTART_MANIFEST;
  assert(path, "Restart worker requires an isolated manifest.");
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

export async function cleanupLocalFixture(
  admin: Admin,
  input: { workspaceId: string; userId: string },
) {
  const deliveries = await checked(
    admin
      .from("session_source_deliveries")
      .select("checkpoint_path")
      .eq("workspace_id", input.workspaceId),
  );
  const paths = deliveries
    .map((row) => row.checkpoint_path)
    .filter((path): path is string => Boolean(path));
  for (const path of paths) assert(path.startsWith(`${input.workspaceId}/`));
  if (paths.length) {
    await checked(admin.storage.from("session-source-checkpoints").remove(paths));
    const remainingObjects = await checked(
      admin.storage.from("session-source-checkpoints").list(input.workspaceId),
    );
    assert.equal(remainingObjects.length, 0, "Fixture Storage prefix must be empty after cleanup.");
  }
  const database = new URL(process.env.WALLIE_CONTINUITY_DB_URL!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(database.hostname));
  for (const id of [input.workspaceId, input.userId]) assert(/^[a-f0-9-]{36}$/.test(id));
  execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      `delete from public.workspaces where id='${input.workspaceId}'; delete from auth.users where id='${input.userId}';`,
    ],
    {
      env: {
        ...process.env,
        PGHOST: database.hostname,
        PGPORT: database.port,
        PGDATABASE: database.pathname.slice(1),
        PGUSER: decodeURIComponent(database.username),
        PGPASSWORD: decodeURIComponent(database.password),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    },
  );
  const remainingWorkspace = await admin
    .from("workspaces")
    .select("id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (remainingWorkspace.error) throw remainingWorkspace.error;
  assert.equal(remainingWorkspace.data, null, "Fixture workspace must be removed.");
  const remainingResources = await checked(
    admin.from("workspace_resource_operations").select("id").eq("workspace_id", input.workspaceId),
  );
  assert.equal(remainingResources.length, 0, "Fixture resource reservations must be removed.");
}

export async function createGitFixture(root: string) {
  const remote = join(root, "origin.git");
  const writer = join(root, "writer");
  await mkdir(writer);
  await git(root, "init", "--bare", remote);
  await git(writer, "init", "--initial-branch=main");
  await git(writer, "config", "user.name", "Continuity fixture");
  await git(writer, "config", "user.email", "fixture@example.invalid");
  await mkdir(join(writer, "src"));
  await writeFile(join(writer, "src/original.ts"), 'export const original = "preserve me";\n');
  await git(writer, "add", ".");
  await git(writer, "commit", "-m", "Initial continuity fixture");
  await git(writer, "remote", "add", "origin", remote);
  await git(writer, "push", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { remote, writer, baseSha: await git(writer, "rev-parse", "HEAD") };
}

export function fixtureIds() {
  return {
    workspaceId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    repositoryId: randomUUID(),
    pipelineId: randomUUID(),
    stageIds: [randomUUID(), randomUUID(), randomUUID()],
  };
}
