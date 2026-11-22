import { createHash } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

import { resolveGitHubAppConfig } from "../../src/features/github/config";
import { mintSandboxRepositoryToken } from "../../src/features/github/sandbox-token";
import { factoryImprovementPublicationSchema } from "../../src/lib/factory-proposals/publication-contracts";
import { factoryImprovementValidationReceiptSchema } from "../../src/lib/factory-proposals/validation-contracts";
import {
  factoryImprovementLoopManifestSchema,
  improvementQualificationBase,
  improvementQualificationFixtureId,
  improvementQualificationInstallationSlot,
  improvementQualificationRepository as repository,
  improvementQualificationRepositoryId as repositoryId,
  type ImprovementLoopContext,
  type ImprovementLoopGitHubInstallation,
  type ImprovementLoopPrepared,
} from "./factory-improvement-loop-contract";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const gitObject = z.object({ sha });
const gitRef = z.object({ object: gitObject });
const configurationBlob = z.object({
  sha,
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
});
export const improvementLoopBaseProofSchema = z.object({
  baseCommitSha: sha,
  parentCommitSha: sha,
});
type BaseProof = z.output<typeof improvementLoopBaseProofSchema>;
type FixtureBase = { baseBranch: string; baseCommitSha: string; configPath: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openScopedGitHub(purpose: "pull-request-read" | "execution") {
  const [owner, repo] = repository.split("/") as [string, string];
  const { App } = await import("@octokit/app");
  const app = new App(resolveGitHubAppConfig());
  const request = { request: { signal: AbortSignal.timeout(15_000) } };
  const [{ data: identity }, { data: installation }] = await Promise.all([
    app.octokit.request("GET /app", request),
    app.octokit
      .request("GET /repos/{owner}/{repo}/installation", { owner, repo, ...request })
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "status" in error && error.status === 404) {
          throw new Error(`Install the configured Wallie GitHub App on ${repository} to continue.`);
        }
        throw error;
      }),
  ]);
  check(
    identity?.slug &&
      !installation.suspended_at &&
      installation.app_id === identity.id &&
      installation.permissions.contents === "write" &&
      installation.permissions.pull_requests === "write",
    "The configured GitHub App needs active write access to the fixture repository.",
  );
  const token = await mintSandboxRepositoryToken({
    installationId: installation.id,
    repositoryFullName: repository,
    repositoryId,
    purpose,
    signal: AbortSignal.timeout(15_000),
  });

  async function github(path: string, body?: Record<string, unknown>, allowMissing = false) {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (response.status === 404 && allowMissing) return null;
    check(response.ok, `The scoped GitHub request returned HTTP ${response.status}.`);
    return (await response.json()) as unknown;
  }

  const metadata = z
    .object({
      id: z.literal(repositoryId),
      full_name: z.literal(repository),
      default_branch: z.literal("main"),
      html_url: z.literal(`https://github.com/${repository}`),
      private: z.boolean(),
    })
    .parse(await github(""));
  return { github, metadata, installation, author: `${identity.slug}[bot]`, owner, repo };
}

type ScopedGitHub = Awaited<ReturnType<typeof openScopedGitHub>>;

export async function readImprovementLoopGitHubInstallation(): Promise<ImprovementLoopGitHubInstallation> {
  const { installation, owner } = await openScopedGitHub("pull-request-read");
  return {
    id: installation.id,
    appId: installation.app_id,
    url: installation.html_url,
    targetType: installation.target_type,
    owner,
  };
}

async function readConfiguration(remote: ScopedGitHub, path: string, commit: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const blob = configurationBlob.parse(
    await remote.github(`/contents/${encodedPath}?ref=${commit}`),
  );
  const digest = createHash("sha256").update(Buffer.from(blob.content, "base64")).digest("hex");
  return { sha: blob.sha, digest };
}

async function verifyFixtureBase(
  remote: ScopedGitHub,
  fixture: ImprovementLoopPrepared,
  configPath: string,
  proof: BaseProof,
) {
  const [commit, difference, , contents] = await Promise.all([
    remote.github(`/git/commits/${proof.baseCommitSha}`).then((value) =>
      z
        .object({
          sha: z.literal(proof.baseCommitSha),
          parents: z.tuple([z.object({ sha: z.literal(proof.parentCommitSha) })]),
          message: z.literal(`Wallie OP-642 isolated qualification fixture ${fixture.runId}`),
          tree: gitObject,
        })
        .parse(value),
    ),
    remote.github(`/compare/${proof.parentCommitSha}...${proof.baseCommitSha}`).then((value) =>
      z
        .object({
          total_commits: z.literal(1),
          files: z.tuple([z.object({ filename: z.literal(configPath), sha })]),
        })
        .parse(value),
    ),
    remote.github(`/compare/${proof.parentCommitSha}...main`).then((value) =>
      z
        .object({
          status: z.enum(["ahead", "identical"]),
          merge_base_commit: z.object({ sha: z.literal(proof.parentCommitSha) }),
        })
        .parse(value),
    ),
    readConfiguration(remote, configPath, proof.baseCommitSha),
  ]);
  check(
    contents.sha === difference.files[0].sha && contents.digest === fixture.baseline.digest,
    "The saved one-file base intent does not match the exact baseline.",
  );

  let treeSha = commit.tree.sha;
  const segments = configPath.split("/");
  for (let index = 0; index < segments.length; index++) {
    const tree = z
      .object({
        tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string(), sha })),
      })
      .parse(await remote.github(`/git/trees/${treeSha}`));
    const entry = tree.tree.find(({ path }) => path === segments[index]);
    if (index === segments.length - 1) {
      check(
        entry?.type === "blob" && entry.mode === "100644" && entry.sha === contents.sha,
        "The fixture configuration must be a regular file in the saved base tree.",
      );
    } else {
      check(entry?.type === "tree", "The saved fixture base lacks the exact configuration path.");
      treeSha = entry.sha;
    }
  }
}

async function connectFixtureRepository(
  admin: ImprovementLoopContext["admin"],
  fixture: ImprovementLoopPrepared,
  remote: ScopedGitHub,
) {
  const { workspaceId, factoryId, runId } = fixture;
  check(
    workspaceId === runId &&
      fixture.workspaceSlug === `m10-${runId}` &&
      fixture.ownerEmail === `${fixture.workspaceSlug}@example.test`,
    "Only this run’s disposable workspace can receive the repository connection.",
  );
  const [localWorkspace, localInstallation] = await Promise.all([
    admin
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("slug", fixture.workspaceSlug)
      .maybeSingle(),
    admin
      .from("github_installations")
      .select("id, installation_id, app_id, suspended")
      .eq("workspace_id", workspaceId)
      .single(),
  ]);
  check(
    !localWorkspace.error && localWorkspace.data,
    "The exact disposable workspace could not be verified.",
  );
  const { data: current, error } = localInstallation;
  check(
    !error &&
      current &&
      current.id ===
        improvementQualificationFixtureId(runId, improvementQualificationInstallationSlot) &&
      current.installation_id === remote.installation.id &&
      current.app_id === remote.installation.app_id &&
      !current.suspended,
    "The fixture was not prepared with this active GitHub App installation.",
  );

  const { data, error: repositoryError } = await admin
    .from("github_repositories")
    .upsert(
      {
        workspace_id: workspaceId,
        factory_id: factoryId,
        github_installation_id: current.id,
        repo_id: repositoryId,
        name: remote.repo,
        full_name: repository,
        html_url: remote.metadata.html_url,
        private: remote.metadata.private,
        default_branch: remote.metadata.default_branch,
        is_archived: false,
      },
      { onConflict: "github_installation_id,repo_id" },
    )
    .select("id")
    .single();
  check(
    !repositoryError && data,
    "Could not attach the verified repository to the fixture factory.",
  );
  return data.id;
}

async function ensureFixtureBase(
  remote: ScopedGitHub,
  fixture: ImprovementLoopPrepared,
  definitionJson: string,
  previous: BaseProof | undefined,
  saveBase: (proof: BaseProof) => Promise<void>,
) {
  const github = remote.github;
  const baseBranch = improvementQualificationBase(fixture.runId);
  const configPath = `.wallie/factory-definitions/${fixture.factoryId}.json`;
  const basePath = `/git/ref/heads/${baseBranch}`;
  const current = await github(basePath, undefined, true);
  let proof = previous;
  if (!proof) {
    check(
      current === null,
      "The new fixture base branch already exists without a saved creation intent.",
    );
    const parentCommitSha = gitRef.parse(await github("/git/ref/heads/main")).object.sha;
    const original = z
      .object({ tree: gitObject })
      .parse(await github(`/git/commits/${parentCommitSha}`));
    const blob = gitObject.parse(
      await github("/git/blobs", {
        content: Buffer.from(definitionJson, "utf8").toString("base64"),
        encoding: "base64",
      }),
    );
    const tree = gitObject.parse(
      await github("/git/trees", {
        base_tree: original.tree.sha,
        tree: [{ path: configPath, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    );
    const commit = gitObject.parse(
      await github("/git/commits", {
        message: `Wallie OP-642 isolated qualification fixture ${fixture.runId}`,
        tree: tree.sha,
        parents: [parentCommitSha],
      }),
    );
    proof = { baseCommitSha: commit.sha, parentCommitSha };
    await saveBase(proof);
  }
  await verifyFixtureBase(remote, fixture, configPath, proof);
  if (current === null) {
    await github("/git/refs", { ref: `refs/heads/${baseBranch}`, sha: proof.baseCommitSha });
  }
  check(
    gitRef.parse(await github(basePath)).object.sha === proof.baseCommitSha,
    "The scoped qualification base no longer points to its saved commit.",
  );
  return { baseBranch, baseCommitSha: proof.baseCommitSha, configPath };
}

export async function publishImprovementLoop({
  context,
  fixture,
  browser,
  installationId,
  baseProof,
  saveBase,
}: {
  context: ImprovementLoopContext;
  fixture: ImprovementLoopPrepared;
  browser: APIRequestContext;
  installationId: number;
  baseProof?: BaseProof;
  saveBase: (proof: BaseProof) => Promise<void>;
}) {
  const { admin } = context;
  const { workspaceId, factoryId, actorUserId, proposalId, proposalRevisionId } = fixture;
  const { data, error } = await admin.rpc("get_factory_improvement_validation", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_proposal_id: proposalId,
    p_proposal_revision_id: proposalRevisionId,
  });
  check(!error, "The exact local validation receipt could not be read.");
  const validation = factoryImprovementValidationReceiptSchema.parse(data);
  check(
    validation.id === fixture.validationId &&
      validation.status === "qualified" &&
      validation.base.activationNumber === fixture.baseline.activationNumber &&
      validation.base.revisionId === fixture.baseline.revisionId &&
      validation.base.digest === fixture.baseline.digest &&
      validation.candidate.revisionId === fixture.candidate.revisionId &&
      validation.candidate.digest === fixture.candidate.digest &&
      validation.targeted.experimentId === fixture.targetedExperimentId &&
      validation.holdout.experimentId === fixture.holdoutExperimentId,
    "Both paired experiments must still qualify the saved exact candidate.",
  );

  const { data: definition, error: definitionError } = await admin
    .from("factory_definition_revisions")
    .select("definition_json,canonical_digest")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", fixture.baseline.revisionId)
    .single();
  check(
    !definitionError &&
      definition &&
      definition.canonical_digest === fixture.baseline.digest &&
      createHash("sha256").update(definition.definition_json, "utf8").digest("hex") ===
        fixture.baseline.digest,
    "The saved active definition bytes no longer match the qualified baseline.",
  );

  const factoryPath = `${fixture.appOrigin}/api/workspaces/${workspaceId}/factories/${factoryId}`;
  const endpoint = `${factoryPath}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/publication`;
  const headers = { origin: fixture.appOrigin };
  const receiptSchema = z.object({ publication: factoryImprovementPublicationSchema });
  const existing = await browser.get(endpoint, { headers });
  check(
    [200, 404].includes(existing.status()),
    `The signed publication read returned HTTP ${existing.status()}.`,
  );
  const recorded =
    existing.status() === 200 ? receiptSchema.parse(await existing.json()).publication : null;
  const reconcileExisting = Boolean(recorded?.pullRequest || recorded?.creationArmed);
  const remote = await openScopedGitHub(reconcileExisting ? "pull-request-read" : "execution");
  check(remote.installation.id === installationId, "The prepared GitHub App installation changed.");

  let publication = recorded;
  let recovered = Boolean(recorded?.pullRequest);
  let base: FixtureBase;
  if (recorded && reconcileExisting) {
    check(baseProof, "Recovering a publication requires the saved base intent.");
    base = {
      baseBranch: improvementQualificationBase(fixture.runId),
      baseCommitSha: baseProof.baseCommitSha,
      configPath: `.wallie/factory-definitions/${fixture.factoryId}.json`,
    };
    check(
      recorded.baseCommitSha === base.baseCommitSha &&
        recorded.target.repositoryNumericId === repositoryId &&
        recorded.target.installationId === installationId &&
        recorded.target.baseBranch === base.baseBranch &&
        recorded.target.configPath === base.configPath,
      "The recorded publication does not match the saved fixture base intent.",
    );
    await verifyFixtureBase(remote, fixture, base.configPath, baseProof);
  } else {
    const localRepositoryId = await connectFixtureRepository(admin, fixture, remote);
    const baseBranch = improvementQualificationBase(fixture.runId);
    const target = await browser.post(`${factoryPath}/improvement-publication-target`, {
      headers,
      data: { repositoryId: localRepositoryId, baseBranch },
    });
    check(
      target.status() === 200,
      `The signed publication target returned HTTP ${target.status()}.`,
    );
    base = await ensureFixtureBase(
      remote,
      fixture,
      definition.definition_json,
      baseProof,
      saveBase,
    );
  }
  if (!publication?.pullRequest) {
    const response = await browser.post(endpoint, { headers, timeout: 125_000 });
    check(
      [200, 201, 202].includes(response.status()),
      `The signed publication returned HTTP ${response.status()}.`,
    );
    if (response.status() === 202) return null;
    const result = receiptSchema
      .extend({ state: z.literal("published"), replay: z.boolean() })
      .parse(await response.json());
    check(
      response.status() === (result.replay ? 200 : 201) &&
        (!recorded?.creationArmed || result.replay),
      "The publication status did not match its replay receipt.",
    );
    publication = result.publication;
    recovered = result.replay;
  }
  check(
    publication?.pullRequest &&
      publication.headCommitSha &&
      publication.current &&
      publication.validationId === fixture.validationId &&
      publication.proposalId === proposalId &&
      publication.proposalRevisionId === proposalRevisionId &&
      publication.base.activationNumber === fixture.baseline.activationNumber &&
      publication.base.revisionId === fixture.baseline.revisionId &&
      publication.base.digest === fixture.baseline.digest &&
      publication.candidate.revisionId === fixture.candidate.revisionId &&
      publication.candidate.digest === fixture.candidate.digest &&
      publication.target.repositoryNumericId === repositoryId &&
      publication.target.baseBranch === base.baseBranch &&
      publication.baseCommitSha === base.baseCommitSha &&
      publication.target.configPath === base.configPath,
    "The production publication receipt did not match the exact scoped qualification.",
  );

  const pull = z
    .object({
      number: z.literal(publication.pullRequest.number),
      html_url: z.literal(publication.pullRequest.url),
      user: z.object({ type: z.literal("Bot"), login: z.literal(remote.author) }),
      state: z.enum(["open", "closed"]),
      draft: z.boolean(),
      merged: z.boolean(),
      merged_at: z.string().datetime().nullable(),
      merge_commit_sha: sha.nullable(),
      base: z.object({
        ref: z.literal(base.baseBranch),
        sha: z.literal(base.baseCommitSha),
        repo: z.object({ id: z.literal(repositoryId) }),
      }),
      head: z.object({
        ref: z.literal(publication.target.headBranch),
        sha: z.literal(publication.headCommitSha),
        repo: z.object({ id: z.literal(repositoryId) }),
      }),
    })
    .parse(await remote.github(`/pulls/${publication.pullRequest.number}`));
  if (!recovered) {
    check(
      pull.state === "open" && pull.draft,
      "The initial qualification publication must be an open GitHub draft.",
    );
  } else if (pull.state === "closed") {
    check(
      pull.merged && pull.merged_at && pull.merge_commit_sha,
      "The scoped qualification pull request was closed without being merged.",
    );
  }
  const [difference, candidate] = await Promise.all([
    remote.github(`/compare/${pull.base.sha}...${pull.head.sha}`).then((value) =>
      z
        .object({
          total_commits: z.literal(1),
          files: z.tuple([z.object({ filename: z.literal(base.configPath), sha })]),
        })
        .parse(value),
    ),
    readConfiguration(remote, base.configPath, pull.head.sha),
  ]);
  check(
    candidate.sha === difference.files[0].sha && candidate.digest === fixture.candidate.digest,
    "The App-authored pull request must contain the exact tested candidate bytes.",
  );

  const manifest = factoryImprovementLoopManifestSchema.parse({
    ...fixture,
    publication: {
      ...base,
      id: publication.id,
      number: pull.number,
      url: pull.html_url,
      headBranch: pull.head.ref,
      headCommitSha: pull.head.sha,
      repositoryNumericId: repositoryId,
    },
  });
  return { manifest, merged: pull.merged };
}
