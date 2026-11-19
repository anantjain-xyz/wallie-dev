import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { fetchGitHubContextFile } from "@/lib/factory-context/github-source";
import { factoryMcpManifestSchema } from "@/lib/factory-mcp/manifest";
import type { Database, Tables } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

export type M05Workspace = {
  workspaceId: string;
  factoryId: string;
  actorId: string;
  installationId: string;
};

export type M05Revision = {
  commit: string;
  body: string;
};

type M05ContextRepository = {
  id: string;
  fullName: string;
  installationId: number;
  repositoryId: number;
  filePath: string;
  old: M05Revision;
  new: M05Revision;
};

type M05MemoryApproval = {
  memoryId: string;
  revisionId: string;
  approvalId: string;
  contentSha256: string;
};

const filePath = "docs/qualification.md";
const contextToken = "synthetic-local-m05-context-token";
const upstreamUpdatedAt = "2026-01-01T00:00:00.000Z";
export const M05_ORIGINAL_DOCUMENT = "M05 original private context.\n";
export const M05_UPDATED_DOCUMENT = "M05 updated private context.\n";
export const M05_ORIGINAL_MEMORY = "M05 original approved memory.";
export const M05_UPDATED_MEMORY = "M05 corrected approved memory.";

function scope(workspace: M05Workspace) {
  return {
    p_workspace_id: workspace.workspaceId,
    p_factory_id: workspace.factoryId,
  };
}

function managementScope(workspace: M05Workspace) {
  return { ...scope(workspace), p_actor_user_id: workspace.actorId };
}

async function checked<T>(
  request: PromiseLike<{ data: T; error: unknown }>,
  operation: string,
): Promise<NonNullable<T>> {
  const { data, error } = await request;
  if (error) throw new Error(operation, { cause: error });
  assert(data !== null && data !== undefined, operation);
  return data;
}

function digest(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

export async function registerM05ContextRepository(admin: Client, workspace: M05Workspace) {
  const installation = await checked(
    admin
      .from("github_installations")
      .select("installation_id,target_name")
      .eq("workspace_id", workspace.workspaceId)
      .eq("id", workspace.installationId)
      .eq("suspended", false)
      .single(),
    "load the connected fixture installation",
  );
  const name = "private-context";
  const fullName = installation.target_name + "/" + name;
  const repository = await checked(
    admin
      .from("github_repositories")
      .insert({
        workspace_id: workspace.workspaceId,
        factory_id: workspace.factoryId,
        github_installation_id: workspace.installationId,
        repo_id: randomInt(100_000_000, 2_000_000_000),
        name,
        full_name: fullName,
        private: true,
        html_url: "https://github.com/" + fullName,
        default_branch: "main",
      })
      .select("id,full_name,repo_id")
      .single(),
    "create the fixture's separate read-context repository",
  );
  return {
    id: repository.id,
    fullName: repository.full_name,
    installationId: installation.installation_id,
    repositoryId: repository.repo_id,
    filePath,
    old: { commit: "1".repeat(40), body: M05_ORIGINAL_DOCUMENT },
    new: { commit: "2".repeat(40), body: M05_UPDATED_DOCUMENT },
  } satisfies M05ContextRepository;
}

export function createM05ContextProvider() {
  let repository: M05ContextRepository | undefined;
  let head = "";
  let access: "available" | "revoked" = "available";
  const resources = new Map<string, () => Response>();
  const requests: string[] = [];

  function bind(value: M05ContextRepository) {
    assert(!repository, "The fixture already has a scoped context repository.");
    assert.equal(value.filePath, filePath);
    repository = value;
    head = value.old.commit;

    function addRevision(revision: M05Revision, rootTree: string, docsTree: string) {
      const bodyBytes = Buffer.byteLength(revision.body, "utf8");
      const blob = createHash("sha1")
        .update(`blob ${bodyBytes}\0`)
        .update(revision.body)
        .digest("hex");
      resources.set("git/commits/" + revision.commit, () =>
        Response.json({
          sha: revision.commit,
          committer: { date: upstreamUpdatedAt },
          tree: { sha: rootTree },
        }),
      );
      resources.set("git/trees/" + rootTree, () =>
        Response.json({
          sha: rootTree,
          truncated: false,
          tree: [{ path: "docs", mode: "040000", type: "tree", sha: docsTree }],
        }),
      );
      resources.set("git/trees/" + docsTree, () =>
        Response.json({
          sha: docsTree,
          truncated: false,
          tree: [
            { path: "qualification.md", mode: "100644", type: "blob", sha: blob, size: bodyBytes },
          ],
        }),
      );
      resources.set("git/blobs/" + blob, () => new Response(revision.body));
    }

    addRevision(value.old, "3".repeat(40), "4".repeat(40));
    addRevision(value.new, "5".repeat(40), "6".repeat(40));
  }

  function setHead(commit: string) {
    assert(repository && (commit === repository.old.commit || commit === repository.new.commit));
    head = commit;
  }

  function setAccess(value: "available" | "revoked") {
    access = value;
  }

  function mintToken(input: Parameters<typeof mintSandboxRepositoryToken>[0]) {
    if (input.purpose !== "read-context") return undefined;
    assert(repository, "The fixture has no bound context repository.");
    assert.equal(input.installationId, repository.installationId);
    assert.equal(input.repositoryId, repository.repositoryId);
    assert.equal(input.repositoryFullName, repository.fullName);
    input.signal?.throwIfAborted();
    return contextToken;
  }

  function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    const url = new URL(request?.url ?? String(input));
    if (url.hostname !== "api.github.com") return undefined;
    assert(repository, "Unexpected GitHub request before the context fixture was bound.");
    const prefix = `/repositories/${repository.repositoryId}/`;
    assert(
      url.origin === "https://api.github.com" && url.pathname.startsWith(prefix) && !url.search,
    );
    assert.equal(init?.method ?? request?.method ?? "GET", "GET");
    const headers = new Headers(init?.headers ?? request?.headers);
    assert(
      headers.get("Authorization") === `Bearer ${contextToken}`,
      "Context GitHub request used the wrong fixture credential.",
    );
    (init?.signal ?? request?.signal)?.throwIfAborted();
    const resource = url.pathname.slice(prefix.length);
    requests.push(resource);
    if (access === "revoked") return new Response("Repository access revoked.", { status: 403 });
    if (resource === "commits/HEAD") {
      assert.equal(headers.get("Accept"), "application/vnd.github.sha");
      return new Response(head + "\n");
    }

    const reply = resources.get(resource);
    assert(reply, "Unexpected GitHub context resource: " + resource);
    assert.equal(
      headers.get("Accept"),
      resource.startsWith("git/blobs/")
        ? "application/vnd.github.raw+json"
        : "application/vnd.github+json",
    );
    return reply();
  }

  return { bind, setHead, setAccess, requests, mintToken, fixtureFetch };
}

export async function registerM05BrowserTools(admin: Client, workspace: M05Workspace) {
  const serverSlug = "m05-browser-fixture";
  const [agent, tool] = await Promise.all([
    checked(
      admin
        .from("factory_agents")
        .select("id")
        .eq("workspace_id", workspace.workspaceId)
        .eq("factory_id", workspace.factoryId)
        .eq("is_default", true)
        .single(),
      "load the fixture's default implementation agent",
    ),
    checked(
      admin.rpc("create_factory_mcp_server", {
        ...managementScope(workspace),
        p_slug: serverSlug,
        p_name: "M05 browser fixture",
        p_endpoint: "https://browser-fixture.example.test/mcp",
        p_operation_names: ["capture", "record_video"],
        p_auth_kind: "none",
      }),
      "register the exact browser capture operations",
    ),
  ]);
  return {
    screenshotScopeId: tool.id + "/capture",
    videoScopeId: tool.id + "/record_video",
    mcpManifest: factoryMcpManifestSchema.parse({
      agentId: agent.id,
      servers: [
        {
          toolRevisionId: tool.id,
          serverId: tool.server_id,
          serverSlug,
          revisionNumber: tool.revision_number,
          endpoint: tool.endpoint,
          operations: tool.operation_names,
          auth: { kind: "none" },
        },
      ],
    }),
  };
}

export async function registerM05ContextSource(
  admin: Client,
  workspace: M05Workspace,
  grant: Pick<Tables<"factory_execution_grants">, "id" | "version">,
  repository: M05ContextRepository,
) {
  const source = await checked(
    admin.rpc("register_factory_context_source", {
      ...managementScope(workspace),
      p_repository_id: repository.id,
      p_grant_id: grant.id,
      p_grant_version: grant.version,
      p_file_path: repository.filePath,
    }),
    "register the approved exact context file",
  );
  assert.equal(source.upstream_repository_id, repository.repositoryId);
  assert.equal(source.grant_version, grant.version);
  return source.id;
}

export async function syncM05ContextRevision(
  admin: Client,
  workspace: M05Workspace,
  sourceId: string,
  revision: M05Revision,
) {
  const args = { ...managementScope(workspace), p_source_id: sourceId };
  const lease = await checked(
    admin.rpc("claim_factory_context_source_sync", args).single(),
    "claim the context source sync",
  );
  assert.equal(lease.status, "syncing");
  assert(lease.lease_id);
  const fetched = await fetchGitHubContextFile({
    installationId: lease.installation_id,
    repositoryId: lease.repository_id,
    repositoryFullName: lease.repository_full_name,
    filePath: lease.file_path,
  });
  if (fetched.status !== "synced")
    throw new Error("Fixture context sync returned " + fetched.status);
  assert.equal(fetched.upstreamRevision, revision.commit);
  assert.equal(fetched.content, revision.body);
  const source = await checked(
    admin.rpc("settle_factory_context_source_sync", {
      ...args,
      p_lease_id: lease.lease_id,
      p_status: fetched.status,
      p_content: fetched.content,
      p_upstream_revision: fetched.upstreamRevision,
      p_upstream_updated_at: fetched.upstreamUpdatedAt,
    }),
    "settle exact upstream context bytes",
  );
  assert.equal(source.status, "synced");
  assert(source.current_revision_id);
  const persisted = await checked(
    admin
      .from("factory_context_source_revisions")
      .select("content_sha256,content_bytes,upstream_revision")
      .eq("workspace_id", workspace.workspaceId)
      .eq("factory_id", workspace.factoryId)
      .eq("source_id", sourceId)
      .eq("id", source.current_revision_id)
      .single(),
    "read retained context identity",
  );
  assert.equal(persisted.content_sha256, digest(revision.body));
  assert.equal(persisted.content_bytes, Buffer.byteLength(revision.body, "utf8"));
  assert.equal(persisted.upstream_revision, revision.commit);
  return {
    sourceId,
    revisionId: source.current_revision_id,
    contentSha256: persisted.content_sha256,
    contentBytes: persisted.content_bytes,
    upstreamRevision: persisted.upstream_revision,
  };
}

async function approvePendingMemory(
  viewer: Client,
  workspace: M05Workspace,
  family: Pick<Tables<"factory_memories">, "id" | "pending_revision_id">,
  expectedBody: string,
): Promise<M05MemoryApproval> {
  assert(family.pending_revision_id, "The exact memory family must be pending.");
  const approved = await checked(
    viewer.rpc("review_factory_memory", {
      ...scope(workspace),
      p_memory_id: family.id,
      p_decision: "approve",
      p_expected_pending_revision_id: family.pending_revision_id,
    }),
    "record the signed-in manager's exact approval",
  );
  assert.equal(approved.current_revision_id, family.pending_revision_id);
  assert(approved.current_approval_id);
  const revision = await checked(
    viewer
      .from("factory_memory_revisions")
      .select("content_sha256")
      .eq("workspace_id", workspace.workspaceId)
      .eq("factory_id", workspace.factoryId)
      .eq("memory_id", family.id)
      .eq("id", family.pending_revision_id)
      .single(),
    "read the approved memory revision digest",
  );
  assert.equal(revision.content_sha256, digest(expectedBody));
  return {
    memoryId: family.id,
    revisionId: family.pending_revision_id,
    approvalId: approved.current_approval_id,
    contentSha256: revision.content_sha256,
  };
}

export async function approveM05Memory(
  viewer: Client,
  admin: Client,
  workspace: M05Workspace,
  producerRunId: string,
) {
  const checkpoint = await checked(
    admin
      .from("session_git_checkpoints")
      .select("artifact_id,session_id")
      .eq("workspace_id", workspace.workspaceId)
      .eq("run_id", producerRunId)
      .single(),
    "find the accepted artifact of the memory producer",
  );
  const artifact = await checked(
    viewer
      .from("session_artifacts")
      .select("id,version")
      .eq("workspace_id", workspace.workspaceId)
      .eq("session_id", checkpoint.session_id)
      .eq("id", checkpoint.artifact_id)
      .single(),
    "inspect the exact published source as the manager",
  );
  const pending = await checked(
    viewer.rpc("propose_factory_memory", {
      ...scope(workspace),
      p_artifact_id: artifact.id,
      p_artifact_version: artifact.version,
      p_title: "M05 qualification memory",
    }),
    "transfer the producer's private proposal into the manager review queue",
  );
  assert.equal(pending.source_run_id, producerRunId);
  assert.equal(pending.current_revision_id, null);
  return approvePendingMemory(viewer, workspace, pending, M05_ORIGINAL_MEMORY);
}

export async function correctM05Memory(
  viewer: Client,
  workspace: M05Workspace,
  approval: M05MemoryApproval,
  newBody = M05_UPDATED_MEMORY,
) {
  const pending = await checked(
    viewer.rpc("correct_factory_memory", {
      ...scope(workspace),
      p_memory_id: approval.memoryId,
      p_body_md: newBody,
      p_expected_current_revision_id: approval.revisionId,
    }),
    "replace the former approval with a fresh pending memory revision",
  );
  assert.equal(pending.current_revision_id, null);
  assert.notEqual(pending.pending_revision_id, approval.revisionId);
  return approvePendingMemory(viewer, workspace, pending, newBody);
}
