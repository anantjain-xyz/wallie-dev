/**
 * Seed with `psql -XqAt -v base_branch=wallie/improvement-smoke/<uuid>/base
 * -f scripts/fixtures/improvement-publication-smoke.psql` on a disposable local stack.
 * Run using Node with `--import ./scripts/register-server-only.mjs --import tsx`.
 * Preview reads only the synthetic receipt. `--preflight` reads GitHub before `--execute`.
 * Both modes requiring GitHub use the local GitHub CLI operator.
 * The unique GitHub refs and PR are preserved. Run the seed with `-v cleanup=1` to clear local rows.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const repository = "anantjain-xyz/wallie-dev";
const repositoryId = 1196742316;
const apiRoot = `https://api.github.com/repos/${repository}`;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fixtureSlot = (slot: number) => `62300000-0000-4000-9000-${String(slot).padStart(12, "0")}`;
const fixtureSchema = z.object({
  workspaceId: z.literal(fixtureSlot(11)),
  factoryId: z.string().uuid(),
  actorUserId: z.literal(fixtureSlot(1)),
  proposalId: z.literal(fixtureSlot(300)),
  proposalRevisionId: z.literal(fixtureSlot(312)),
  baseBranch: z.string().regex(/^wallie\/improvement-smoke\/[0-9a-f-]{36}\/base$/),
  baselineDefinitionJson: z.string(),
  baselineDigest: digest,
  candidateDigest: digest,
});
const refSchema = z.object({ object: z.object({ sha }) });
const objectSchema = z.object({ sha });
const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.literal("open"),
  base: z.object({ ref: z.string(), sha }),
  head: z.object({ ref: z.string(), sha }),
});
type Fixture = z.infer<typeof fixtureSchema>;

let phase = "arguments";

function operatorApi(url: URL, method: string, body: string | undefined, signal?: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      method,
      "--include",
      url.pathname + url.search,
    ];
    if (body) args.push("--input", "-", "-H", "Content-Type: application/json");
    const child = spawn("gh", args, { signal, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on("error", reject);
    child.on("error", reject);
    child.on("close", () => {
      const wire = Buffer.concat(chunks).toString("utf8");
      const head = /^(HTTP\/\S+ (\d+) [^\r\n]*(?:\r?\n[^\r\n]+)*)\r?\n\r?\n/.exec(wire);
      if (!head) return reject(new Error("GitHub CLI returned no HTTP response"));
      const status = Number(head[2]);
      const headers = new Headers();
      for (const line of head[1].split(/\r?\n/).slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      resolve(
        new Response([204, 205, 304].includes(status) ? null : wire.slice(head[0].length), {
          status,
          headers,
        }),
      );
    });
    child.stdin.end(body);
  });
}

function smokeTransport(fixture: Fixture, headBranch: string, configPath: string) {
  const base = new URL(apiRoot);
  const repositoryPaths = [base.pathname, `/repositories/${repositoryId}`];
  let posts = 0;
  let dropped = false;
  let delayedDiscovery = false;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert(url.origin === base.origin && !url.username && !url.password);
    const repositoryPath = repositoryPaths.find(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );
    assert(repositoryPath);
    const path = url.pathname.slice(repositoryPath.length);
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body !== undefined) {
      const data: unknown = JSON.parse(body);
      if (path === "/pulls") {
        const pr = z.object({ base: z.string(), head: z.string() }).parse(data);
        assert.equal(pr.base, fixture.baseBranch);
        assert.equal(pr.head, headBranch);
        posts++;
      } else if (path === "/git/refs") {
        const ref = z.object({ ref: z.string(), sha }).parse(data);
        assert(
          [fixture.baseBranch, headBranch]
            .map((branch) => `refs/heads/${branch}`)
            .includes(ref.ref),
        );
      } else if (path === "/git/trees") {
        const tree = z.object({ tree: z.tuple([z.object({ path: z.string() })]) }).parse(data);
        assert.equal(tree.tree[0].path, configPath);
      } else {
        assert(path === "/git/blobs" || path === "/git/commits");
      }
    } else {
      assert.equal(request.method, "GET");
    }
    const response = await operatorApi(url, request.method, body, request.signal);
    if (path === "/pulls" && body !== undefined && response.status === 201 && !dropped) {
      dropped = true;
      throw new TypeError("Injected loss of the successful GitHub PR response");
    }
    if (path === "/pulls" && body === undefined && dropped && !delayedDiscovery) {
      assert.equal(response.status, 200);
      delayedDiscovery = true;
      await response.body?.cancel();
      return Response.json([]);
    }
    return response;
  };
  return { fetcher, proof: () => ({ posts, dropped, delayedDiscovery }) };
}

async function main() {
  const [, , fixturePath, flag, ...remaining] = process.argv;
  assert(
    fixturePath &&
      (flag === undefined || flag === "--preflight" || flag === "--execute") &&
      !remaining.length,
  );
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
  assert.equal(
    createHash("sha256").update(fixture.baselineDefinitionJson).digest("hex"),
    fixture.baselineDigest,
  );
  assert.notEqual(fixture.baselineDigest, fixture.candidateDigest);
  const headBranch = `wallie/improvements/${fixture.factoryId}/${fixture.proposalRevisionId}`;
  const configPath = `.wallie/factory-definitions/${fixture.factoryId}.json`;
  const refs = { base: `refs/heads/${fixture.baseBranch}`, head: `refs/heads/${headBranch}` };
  if (!flag) {
    console.log(JSON.stringify({ status: "preview", repository, repositoryId, refs, configPath }));
    return;
  }

  phase = "github-preflight";
  const signal = AbortSignal.timeout(flag === "--preflight" ? 30_000 : 120_000);
  const { fetcher, proof } = smokeTransport(fixture, headBranch, configPath);
  const read = (path: string) => fetcher(`${apiRoot}${path}`, { signal });
  async function json(path: string, body?: object): Promise<unknown> {
    const response = body
      ? await fetcher(`${apiRoot}${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        })
      : await read(path);
    assert.equal(response.status, body ? 201 : 200);
    return response.json();
  }
  const repo = z
    .object({
      id: z.literal(repositoryId),
      default_branch: z.literal("main"),
      permissions: z.object({ push: z.literal(true) }),
    })
    .parse(await json(""));
  const defaultRef = `/git/ref/heads/${repo.default_branch}`;
  const mainBefore = refSchema.parse(await json(defaultRef)).object.sha;
  for (const branch of [fixture.baseBranch, headBranch]) {
    assert.equal((await read(`/git/ref/heads/${branch}`)).status, 404);
  }
  if (flag === "--preflight") {
    console.log(
      JSON.stringify({
        status: "preflight-passed",
        repository,
        repositoryId,
        refs,
        configPath,
        mainSha: mainBefore,
      }),
    );
    return;
  }

  phase = "local-database";
  const databaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  assert(
    databaseUrl.protocol === "http:" && databaseUrl.hostname === "127.0.0.1" && databaseUrl.port,
  );
  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin");
  const { publishFactoryImprovement } =
    await import("../src/lib/factory-proposals/publication-server");
  const client = createSupabaseAdminClient();
  const { workspaceId, factoryId, actorUserId, proposalId, proposalRevisionId } = fixture;
  const scope = {
    client,
    workspaceId,
    factoryId,
    actorUserId,
    proposalId,
    proposalRevisionId,
    signal,
  };
  const { data: validation, error } = await client.rpc("get_factory_improvement_validation", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_proposal_id: proposalId,
    p_proposal_revision_id: proposalRevisionId,
  });
  assert(!error);
  z.object({ status: z.literal("qualified") }).parse(validation);

  phase = "unique-github-base";
  const mainTree = z.object({ tree: objectSchema }).parse(await json(`/git/commits/${mainBefore}`))
    .tree.sha;
  const baseBlob = objectSchema.parse(
    await json("/git/blobs", {
      content: Buffer.from(fixture.baselineDefinitionJson).toString("base64"),
      encoding: "base64",
    }),
  );
  const baseTree = objectSchema.parse(
    await json("/git/trees", {
      base_tree: mainTree,
      tree: [{ path: configPath, mode: "100644", type: "blob", sha: baseBlob.sha }],
    }),
  );
  const baseCommit = objectSchema.parse(
    await json("/git/commits", {
      message: "Wallie OP-639 isolated smoke baseline",
      tree: baseTree.sha,
      parents: [mainBefore],
    }),
  );
  await json("/git/refs", { ref: refs.base, sha: baseCommit.sha });

  phase = "publication-and-recovery";
  const dependencies = { getToken: async () => "local-operator-smoke-adapter", fetcher };
  // Simulate a lost create response and briefly delayed discovery after GitHub opens the PR.
  const first = await publishFactoryImprovement(scope, dependencies);
  assert.equal(first.state, "pending");
  assert.deepEqual(proof(), { posts: 1, dropped: true, delayedDiscovery: true });
  const recovered = await publishFactoryImprovement(scope, dependencies);
  assert.equal(recovered.state, "published");
  const published = recovered.publication;
  assert.equal(published.id, first.publication.id);
  assert(published.pullRequest && published.headCommitSha);
  const replay = await publishFactoryImprovement(scope, dependencies);
  assert.equal(replay.replay, true);
  assert.equal(replay.publication.pullRequest?.number, published.pullRequest.number);
  assert.deepEqual(proof(), { posts: 1, dropped: true, delayedDiscovery: true });

  phase = "remote-proof";
  const pulls = z
    .array(pullSchema)
    .parse(
      await json(
        `/pulls?${new URLSearchParams({ state: "all", base: fixture.baseBranch, head: `anantjain-xyz:${headBranch}`, per_page: "100" })}`,
      ),
    );
  assert.equal(pulls.length, 1);
  const [pull] = pulls;
  assert.equal(pull.number, published.pullRequest.number);
  assert.deepEqual(pull.base, { ref: fixture.baseBranch, sha: baseCommit.sha });
  assert.deepEqual(pull.head, { ref: headBranch, sha: published.headCommitSha });
  const comparison = z.object({
    total_commits: z.literal(1),
    files: z.tuple([z.object({ filename: z.literal(configPath) })]),
  });
  comparison.parse(await json(`/compare/${pull.base.sha}...${pull.head.sha}`));
  assert.equal(refSchema.parse(await json(defaultRef)).object.sha, mainBefore);
  console.log(
    JSON.stringify({
      status: "passed",
      repository,
      refs,
      configPath,
      pr: published.pullRequest.url,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      onePostAfterResponseLoss: true,
      mainUnchanged: true,
      attribution: "GitHub CLI operator",
    }),
  );
}

void main().catch(() => {
  console.error(`Improvement publication smoke failed during ${phase}.`);
  process.exitCode = 1;
});
