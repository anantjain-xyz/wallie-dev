import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  restoreAndPushSourceWithWorkspace,
  type GitExecutor,
} from "@/lib/pipeline/source-delivery-git-core";
import { SOURCE_CHECKPOINT_REF } from "@/lib/pipeline/source-checkpoint";
import {
  publishClaimedRepositoryCheckpoint,
  type PublicationLease,
  type PublicationScope,
  type PublicationStore,
  type RemoteProof,
  type RetainedRepositoryPublication,
  type RetainedCheckpointPublisher,
} from "./repository-publication";

const directories: string[] = [];
const scope: PublicationScope = {
  workspaceId: "workspace",
  factoryId: "factory",
  rootSessionId: "root",
  parentSessionId: "parent",
  joinId: "join",
};

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(name: string) {
  const parent = mkdtempSync(join(tmpdir(), "wallie-op653-git-"));
  directories.push(parent);
  const source = join(parent, "source");
  const remote = join(parent, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  const local = (...args: string[]) => git("-C", source, ...args);
  git("init", "--quiet", "--initial-branch=main", source);
  local("config", "user.name", "Wallie publication fixture");
  local("config", "user.email", "publication@example.test");
  writeFileSync(join(source, "base.txt"), name);
  local("add", ".");
  local("commit", "-qm", "Immutable base");
  const baseSha = local("rev-parse", "HEAD");
  git("clone", "--quiet", "--bare", source, remote);
  writeFileSync(join(source, "validated.txt"), `validated ${name}`);
  local("add", ".");
  local("commit", "-qm", "Validated parent output");
  const candidateSha = local("rev-parse", "HEAD");
  const validationTreeSha = local("rev-parse", "HEAD^{tree}");
  local("update-ref", SOURCE_CHECKPOINT_REF, candidateSha);
  const bundle = join(parent, "checkpoint.bundle");
  local("bundle", "create", bundle, SOURCE_CHECKPOINT_REF, `^${baseSha}`);
  const bytes = readFileSync(bundle);
  const validationRunId = randomUUID();
  const target: RetainedRepositoryPublication = {
    scope,
    repositoryId: name,
    repositoryNumericId: name === "app" ? 101 : 102,
    repositoryFullName: `fixture/${name}`,
    expectedHeadReceiptId: `accepted-${name}`,
    baseSha,
    candidateSha,
    validationRunId,
    validationTreeSha,
    bundleSha256: createHash("sha256").update(bytes).digest("hex"),
    retainedRef: `refs/wallie/checkpoints/${validationRunId}/${candidateSha}`,
    grantId: `grant-${name}`,
    grantVersion: 1,
  };
  return {
    target,
    bytes,
    remote,
    git,
    read: (ref: string) => {
      try {
        return git("--git-dir", remote, "rev-parse", "--verify", "--quiet", ref);
      } catch (error) {
        if ((error as { status?: number }).status === 1) return null;
        throw error;
      }
    },
    pushes: 0,
    drop: null as "before" | "after" | null,
    beforePush: () => {},
    afterPush: () => {},
  };
}

function fixture() {
  const repositories = [repository("app"), repository("api")];
  const rows = repositories.map((repo) => ({
    repo,
    headReceiptId: repo.target.expectedHeadReceiptId,
    grantVersion: repo.target.grantVersion,
    validation: {
      repositoryId: repo.target.repositoryId,
      runId: repo.target.validationRunId,
      commitSha: repo.target.candidateSha,
      treeSha: repo.target.validationTreeSha,
    },
    status: "pending",
    incompatibleProof: null as RemoteProof | null,
    lease: null as PublicationLease | null,
  }));
  let generation = 1;
  const rowFor = (repositoryId: string) => {
    const row = rows.find((item) => item.repo.target.repositoryId === repositoryId);
    if (!row) throw new Error("Unknown fixture repository");
    return row;
  };
  const claim = (request: PublicationScope, repositoryId: string) => {
    const row = rows.find((item) => item.repo.target.repositoryId === repositoryId);
    if (
      !row ||
      Object.entries(scope).some(
        ([key, value]) => request[key as keyof PublicationScope] !== value,
      ) ||
      row.status === "adopted" ||
      row.lease !== null
    ) {
      return null;
    }
    row.lease = {
      target: row.repo.target,
      generation,
      leaseId: randomUUID(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    return row.lease;
  };
  const store: PublicationStore = {
    async settle(lease, request) {
      const row = rowFor(lease.target.repositoryId);
      if (row.lease !== lease) return "stale_lease";
      const finish = (status: string) => {
        row.status = status;
        row.lease = null;
        return status;
      };
      if (generation !== lease.generation) return finish("stale_lease");
      if (row.headReceiptId !== lease.target.expectedHeadReceiptId) {
        return finish("stale_repository_head");
      }
      if (
        row.grantVersion !== lease.target.grantVersion ||
        row.validation.repositoryId !== lease.target.repositoryId ||
        row.validation.runId !== lease.target.validationRunId ||
        row.validation.commitSha !== lease.target.candidateSha ||
        row.validation.treeSha !== lease.target.validationTreeSha
      ) {
        return finish("authority_unavailable");
      }
      if (request.action === "verify") return "current";
      if (request.action === "retry") return finish("publication_unavailable");
      if (
        request.proof.repositoryNumericId !== lease.target.repositoryNumericId ||
        request.proof.ref !== lease.target.retainedRef
      ) {
        throw new Error("Proof differs from the published target");
      }
      if (request.action === "incompatible_ref") {
        row.incompatibleProof = request.proof;
        return finish("incompatible_ref");
      }
      if (request.proof.sha !== lease.target.candidateSha) {
        throw new Error("Proof differs from the published target");
      }
      return finish("adopted");
    },
  };
  const publisher: RetainedCheckpointPublisher = {
    async read(target, signal) {
      signal.throwIfAborted();
      const sha = rowFor(target.repositoryId).repo.read(target.retainedRef);
      return sha === null
        ? null
        : {
            repositoryNumericId: target.repositoryNumericId,
            ref: target.retainedRef,
            sha,
          };
    },
    async push(target, beforePush, signal) {
      const { repo } = rowFor(target.repositoryId);
      const remoteUrl = `https://github.com/${target.repositoryFullName}.git`;
      const execGit: GitExecutor = async (args, options) => {
        const isPush = args[0] === "push";
        const drop = isPush ? repo.drop : null;
        if (isPush) {
          repo.pushes++;
          repo.drop = null;
        }
        if (drop === "before") throw new Error("Injected Git transport failure");
        if (isPush) repo.beforePush();
        const output = await promisify(execFile)(
          "git",
          args.map((arg) => (arg === remoteUrl ? `file://${repo.remote}` : arg)),
          { ...options, encoding: "utf8", env: { ...options.env, PATH: process.env.PATH } },
        );
        if (isPush) repo.afterPush();
        if (drop === "after") throw new Error("Injected loss of Git acknowledgement");
        return output;
      };
      await restoreAndPushSourceWithWorkspace(
        {
          baseSha: target.baseSha,
          headSha: target.candidateSha,
          bytes: repo.bytes,
          sha256: target.bundleSha256,
          retainedRef: target.retainedRef,
          runId: target.validationRunId,
          token: "synthetic-token",
          remoteUrl,
          beforePush,
          signal,
        },
        {
          execGit,
          async createWorkspace() {
            const path = mkdtempSync(join(tmpdir(), "wallie-op653-restore-"));
            return {
              path,
              async writeBundle(bytes) {
                writeFileSync(join(path, "source.bundle"), bytes);
              },
              async close() {
                rmSync(path, { recursive: true, force: true });
              },
            };
          },
        },
      );
    },
  };
  return {
    app: rows[0]!,
    api: rows[1]!,
    rotate: () => {
      generation++;
    },
    async publish(id: string, who = scope) {
      const lease = claim(who, id);
      return lease ? publishClaimedRepositoryCheckpoint(store, publisher, lease) : "unclaimed";
    },
  };
}

describe("repository publication", () => {
  it("retains a partial result and retries only the failing repository", async () => {
    const f = fixture();
    await expect(f.publish("app")).resolves.toBe("adopted");
    f.api.repo.drop = "before";
    await expect(f.publish("api")).resolves.toBe("publication_unavailable");
    expect([f.app.status, f.api.status]).toEqual(["adopted", "publication_unavailable"]);
    expect(f.api.repo.read(f.api.repo.target.retainedRef)).toBeNull();

    f.api.repo.drop = "after";
    await expect(f.publish("api")).resolves.toBe("adopted");
    await expect(f.publish("app")).resolves.toBe("unclaimed");
    expect([f.app.repo.pushes, f.api.repo.pushes]).toEqual([1, 2]);
    for (const { repo } of [f.app, f.api]) {
      expect(repo.read(repo.target.retainedRef)).toBe(repo.target.candidateSha);
      expect(repo.read("refs/heads/main")).toBe(repo.target.baseSha);
      expect(
        repo.git("--git-dir", repo.remote, "rev-parse", `${repo.target.retainedRef}^{tree}`),
      ).toBe(repo.target.validationTreeSha);
    }
  });

  it("keeps an incompatible retained ref intact even when it is an ancestor", async () => {
    const f = fixture();
    const { repo } = f.api;
    repo.git("--git-dir", repo.remote, "update-ref", repo.target.retainedRef, repo.target.baseSha);
    await expect(f.publish("api")).resolves.toBe("incompatible_ref");
    expect(repo.read(repo.target.retainedRef)).toBe(repo.target.baseSha);
    expect(repo.pushes).toBe(0);
    expect(f.api.incompatibleProof).toEqual({
      repositoryNumericId: repo.target.repositoryNumericId,
      ref: repo.target.retainedRef,
      sha: repo.target.baseSha,
    });
  });

  it("preserves an incompatible ref created after the absent-ref read", async () => {
    const f = fixture();
    const { repo } = f.api;
    repo.beforePush = () => {
      repo.git(
        "--git-dir",
        repo.remote,
        "update-ref",
        repo.target.retainedRef,
        repo.target.baseSha,
      );
    };

    await expect(f.publish("api")).resolves.toBe("incompatible_ref");
    expect(repo.pushes).toBe(1);
    expect(repo.read(repo.target.retainedRef)).toBe(repo.target.baseSha);
  });

  it("denies other parents, foreign validation, and a newer same-SHA head identity before push", async () => {
    const f = fixture();
    await expect(f.publish("api", { ...scope, parentSessionId: "other-parent" })).resolves.toBe(
      "unclaimed",
    );
    f.api.validation = f.app.validation;
    await expect(f.publish("api")).resolves.toBe("authority_unavailable");

    f.app.headReceiptId = "newer-text-only-checkpoint-with-same-sha";
    await expect(f.publish("app")).resolves.toBe("stale_repository_head");
    expect(f.app.repo.read("refs/heads/main")).toBe(f.app.repo.target.baseSha);
    expect([f.app.repo.pushes, f.api.repo.pushes]).toEqual([0, 0]);
  });

  it("refuses adoption after revoke between push and settlement and keeps an exact private ref", async () => {
    const f = fixture();
    f.api.repo.afterPush = () => {
      f.api.grantVersion++;
    };
    await expect(f.publish("api")).resolves.toBe("authority_unavailable");
    expect(f.api.status).toBe("authority_unavailable");
    expect(f.api.repo.read(f.api.repo.target.retainedRef)).toBe(f.api.repo.target.candidateSha);
    await expect(f.publish("api")).resolves.toBe("authority_unavailable");
    expect(f.api.repo.pushes).toBe(1);
  });

  it("allows a new owner to adopt the same exact ref without pushing again", async () => {
    const f = fixture();
    f.api.repo.afterPush = f.rotate;
    await expect(f.publish("api")).resolves.toBe("stale_lease");
    expect(f.api.status).toBe("stale_lease");
    await expect(f.publish("api")).resolves.toBe("adopted");
    expect(f.api.repo.pushes).toBe(1);
  });
});

describe("exact repository claim", () => {
  const claim = (target = repository("app").target): PublicationLease => ({
    target,
    generation: 1,
    leaseId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const store = () => ({
    settle: vi.fn<PublicationStore["settle"]>().mockImplementation(async (_lease, request) => {
      if (request.action === "verify") return "current";
      if (request.action === "retry") return "publication_unavailable";
      return "adopted";
    }),
  });
  const remote = () => ({
    read: vi.fn<RetainedCheckpointPublisher["read"]>().mockResolvedValue(null),
    push: vi.fn<RetainedCheckpointPublisher["push"]>().mockResolvedValue(),
  });

  it("adopts a text-only result by exact repository identity without Git operations", async () => {
    const source = repository("app").target;
    const lease = {
      ...claim(source),
      target: { ...source, candidateSha: source.baseSha, bundleSha256: null, retainedRef: null },
    };
    const database = store();
    const transport = remote();
    await expect(publishClaimedRepositoryCheckpoint(database, transport, lease)).resolves.toBe(
      "adopted",
    );
    expect(database.settle.mock.calls.map((call) => call[1])).toEqual([
      { action: "verify" },
      {
        action: "adopt",
        proof: { repositoryNumericId: source.repositoryNumericId, ref: null, sha: null },
      },
    ]);
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.push).not.toHaveBeenCalled();
  });

  it("refuses observations from other repositories and other refs before a write", async () => {
    const source = repository("api").target;
    const transport = remote();
    const database = store();
    const expected = {
      repositoryNumericId: source.repositoryNumericId,
      ref: source.retainedRef,
      sha: source.candidateSha,
    };
    for (const proof of [
      { ...expected, repositoryNumericId: source.repositoryNumericId + 1 },
      { ...expected, ref: "refs/heads/main" },
      { ...expected, sha: "malformed" },
    ]) {
      transport.read.mockResolvedValueOnce(proof);
      await expect(
        publishClaimedRepositoryCheckpoint(database, transport, claim(source)),
      ).resolves.toBe("publication_unavailable");
    }
    expect(transport.push).not.toHaveBeenCalled();
    expect(database.settle.mock.calls.map((call) => call[1].action)).toEqual([
      "verify",
      "retry",
      "verify",
      "retry",
      "verify",
      "retry",
    ]);
  });

  it("stops before the side effect when maintenance aborts during the first read", async () => {
    const controller = new AbortController();
    const database = store();
    const transport = remote();
    transport.read.mockImplementationOnce(async (_target, signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return null;
    });
    await expect(
      publishClaimedRepositoryCheckpoint(database, transport, claim(), controller.signal),
    ).resolves.toBe("stale_lease");
    expect(transport.push).not.toHaveBeenCalled();
    expect(database.settle).toHaveBeenCalledTimes(1);
  });

  it("does not act under a malformed or expired lease", async () => {
    const database = store();
    const transport = remote();
    const lease = claim();
    for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), "invalid"]) {
      await expect(
        publishClaimedRepositoryCheckpoint(database, transport, { ...lease, expiresAt }),
      ).resolves.toBe("stale_lease");
    }
    expect(database.settle).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.push).not.toHaveBeenCalled();
  });
});
