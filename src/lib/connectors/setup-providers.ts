import "server-only";

import { z } from "zod/v4";

import { createGitHubApp } from "@/features/github/service";
import { LINEAR_GRAPHQL_ENDPOINT } from "@/lib/linear/client";
import { decryptSecretValue } from "@/lib/secrets/crypto";

export const connectorCatalogPageSize = 25;
export const connectorProviderTimeoutMs = 8_000;

export class ConnectorProviderUnavailable extends Error {
  constructor(readonly provider: "github" | "linear") {
    super(`Could not verify ${provider === "github" ? "GitHub" : "Linear"} access.`);
  }
}

const numericId = z.number().int().positive().safe();
const name = z.string().min(1).max(256);
const githubInstallation = z.object({
  id: numericId,
  app_id: numericId,
  suspended_at: z.string().nullable(),
  account: z.object({ id: numericId, login: name.optional(), slug: name.optional() }),
  permissions: z.record(z.string(), z.string()),
});
const githubRepository = z.object({
  id: numericId,
  archived: z.boolean(),
  full_name: z
    .string()
    .max(256)
    .regex(/^[\w-]+\/[\w.-]+$/),
  owner: z.object({ id: numericId }),
});
const githubScopedRepositories = z.object({
  total_count: z.literal(1),
  repositories: z.tuple([githubRepository]),
});
const githubLabel = z.object({
  id: numericId,
  name,
  archived_at: z.iso.datetime({ offset: true }).nullable(),
});
const githubToken = z.object({ token: z.string().min(1) });
const linearNode = z.object({ id: z.uuid().toLowerCase(), name });
const linearPage = z.object({
  nodes: z.array(linearNode).max(connectorCatalogPageSize),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).max(1024).nullable(),
  }),
});

async function guardedProviderRead<T>(
  provider: ConnectorProviderUnavailable["provider"],
  read: () => Promise<T>,
) {
  try {
    return await read();
  } catch {
    throw new ConnectorProviderUnavailable(provider);
  }
}

export async function verifyGitHubCatalogTenant(
  native: { installation_id: number; app_id: number; target_name: string },
  signal: AbortSignal,
) {
  return guardedProviderRead("github", async () => {
    const app = createGitHubApp();
    const request = { signal, redirect: "error" as const };
    const { data } = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: native.installation_id,
      request,
    });
    const installation = githubInstallation.parse(data);
    if (
      installation.id !== native.installation_id ||
      installation.app_id !== native.app_id ||
      installation.suspended_at !== null
    ) {
      throw new Error("GitHub installation changed.");
    }
    return {
      id: String(installation.account.id),
      label: installation.account.login ?? installation.account.slug ?? native.target_name,
      installationId: installation.id,
      app,
      permissions: installation.permissions,
    };
  });
}

type GitHubTenant = Awaited<ReturnType<typeof verifyGitHubCatalogTenant>>;

export async function verifyGitHubCatalogRepository(
  tenant: GitHubTenant,
  repositoryId: number,
  signal: AbortSignal,
  options: { readLabels?: boolean } = {},
) {
  return guardedProviderRead("github", async () => {
    // GitHub only issues this credential if the selected numeric repository
    // belongs to the installation. Read only the metadata needed here.
    const permissions: { metadata: "read"; issues?: "read"; pull_requests?: "read" } = {
      metadata: "read",
    };
    if (options.readLabels) {
      if (tenant.permissions.issues === "read" || tenant.permissions.issues === "write") {
        permissions.issues = "read";
      } else {
        permissions.pull_requests = "read";
      }
    }
    const { data } = await tenant.app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: tenant.installationId,
        repository_ids: [repositoryId],
        permissions,
        request: { signal, redirect: "error" },
      },
    );
    const { token } = githubToken.parse(data);
    const read = async (path: string) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new ConnectorProviderUnavailable("github");
      return response;
    };
    const {
      repositories: [live],
    } = githubScopedRepositories.parse(
      await (await read("/installation/repositories?per_page=1")).json(),
    );
    if (live.id !== repositoryId || live.archived || String(live.owner.id) !== tenant.id) {
      throw new Error("GitHub repository changed.");
    }
    const repositoryPath = `/repos/${live.full_name}`;
    return {
      async listLabels(page: number) {
        return guardedProviderRead("github", async () => {
          const response = await read(
            `${repositoryPath}/labels?per_page=${connectorCatalogPageSize}&page=${page}`,
          );
          const labels = z
            .array(githubLabel)
            .max(connectorCatalogPageSize)
            .parse(await response.json());
          return {
            resources: labels
              .filter((label) => label.archived_at === null)
              .map((label) => ({ id: String(label.id), label: label.name })),
            nextCursor: response.headers.get("link")?.includes('rel="next"')
              ? String(page + 1)
              : null,
          };
        });
      },
      async readLabel(labelName: string) {
        return guardedProviderRead("github", async () =>
          githubLabel.parse(
            await (await read(`${repositoryPath}/labels/${encodeURIComponent(labelName)}`)).json(),
          ),
        );
      },
    };
  });
}

type LinearKind = "team" | "project";

export function linearCatalogProvider(encryptedKey: string, signal: AbortSignal) {
  async function query<Schema extends z.ZodType>(
    document: string,
    variables: Record<string, unknown>,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    return guardedProviderRead("linear", async () => {
      const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: decryptSecretValue(encryptedKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: document, variables }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Linear access is unavailable.");
      const payload = z
        .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
        .parse(await response.json());
      if (payload.errors?.length) throw new Error("Linear could not verify access.");
      return schema.parse(payload.data);
    });
  }

  return {
    async tenant() {
      const { organization } = await query(
        "query ConnectorLinearTenant { organization { id name } }",
        {},
        z.object({ organization: linearNode }),
      );
      return { id: organization.id, label: organization.name };
    },
    async catalog(kind: LinearKind, after: string | null) {
      const connection = kind === "team" ? "teams" : "projects";
      const result = await query(
        `query ConnectorLinearCatalog($first: Int!, $after: String) {
          organization { id name }
          ${connection}(first: $first, after: $after) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: connectorCatalogPageSize, after },
        z.object({
          organization: linearNode,
          teams: linearPage.optional(),
          projects: linearPage.optional(),
        }),
      );
      const page = result[connection];
      if (
        !page ||
        (page.pageInfo.hasNextPage &&
          (!page.pageInfo.endCursor || page.pageInfo.endCursor === after))
      ) {
        throw new ConnectorProviderUnavailable("linear");
      }
      return {
        tenant: { id: result.organization.id, label: result.organization.name },
        resources: page.nodes.map((node) => ({ id: node.id, label: node.name })),
        nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
      };
    },
    async resource(kind: LinearKind, id: string) {
      const result = await query(
        `query ConnectorLinearResource($id: String!) {
          organization { id name }
          ${kind}(id: $id) { id name }
        }`,
        { id },
        z.object({
          organization: linearNode,
          team: linearNode.nullish(),
          project: linearNode.nullish(),
        }),
      );
      return { tenantId: result.organization.id, resourceId: result[kind]?.id ?? null };
    },
  };
}
