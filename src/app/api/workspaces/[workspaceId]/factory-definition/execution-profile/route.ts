import { z } from "zod";

import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import type { FactoryEditorExecutionProfileResponse } from "@/lib/factory-definitions/execution-profile-contracts";
import { checkFactoryProfileCredentialReadiness } from "@/lib/factory-definitions/execution-profile-readiness";
import {
  selectDefaultFactory,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import {
  assertCurrentSandboxCapabilityCheck,
  SandboxCapabilityCheckStaleError,
} from "@/lib/sandbox-capabilities/readiness";
import {
  getEnabledSandboxProviders,
  loadDaytonaSandboxConnectionPreview,
  loadE2BSandboxConnectionPreview,
} from "@/lib/sandbox-connections/server";
import { providerLabel } from "@/lib/sandbox/provider-contract";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadVercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const idSchema = z.string().uuid();
const targetQuery = z.union([
  z
    .object({ draftId: idSchema })
    .strict()
    .transform(({ draftId }) => ({ kind: "draft" as const, id: draftId })),
  z
    .object({ revisionId: idSchema })
    .strict()
    .transform(({ revisionId }) => ({ kind: "revision" as const, id: revisionId })),
]);
const headers = { "Cache-Control": "private, no-store" };

function respond(body: unknown, status = 200) {
  return Response.json(body, { headers, status });
}

type Client = ReturnType<typeof createSupabaseAdminClient>;

async function checkSandboxReadiness({
  admin,
  workspaceId,
  repositoryId,
  digest,
  profile,
}: {
  admin: Client;
  workspaceId: string;
  repositoryId: string;
  digest: string;
  profile: FactoryEditorExecutionProfileResponse["profile"];
}) {
  const provider = profile.sandboxProvider;
  const label = providerLabel(provider);
  if (!getEnabledSandboxProviders().includes(provider)) {
    return { status: "unavailable" as const, reason: `${label} is disabled in this deployment.` };
  }

  const loadConnection = {
    daytona: loadDaytonaSandboxConnectionPreview,
    e2b: loadE2BSandboxConnectionPreview,
    vercel: loadVercelSandboxConnectionPreview,
  }[provider];
  const connection = await loadConnection(admin, workspaceId);
  if (connection?.status !== "connected") {
    return {
      status: "unavailable" as const,
      reason: `Connect ${label} in Settings before running this profile.`,
    };
  }

  try {
    await assertCurrentSandboxCapabilityCheck({
      admin,
      agent: { provider: profile.provider, model: profile.model },
      connection: { provider, revision: connection.connectionRevision ?? connection.updatedAt },
      definitionDigest: digest,
      repositoryId,
      workspaceId,
    });
    return { status: "ready" as const };
  } catch (error) {
    if (!(error instanceof SandboxCapabilityCheckStaleError)) throw error;
    return {
      status: "unavailable" as const,
      reason: `Run a capability check for the primary repository on ${label}.`,
    };
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const workspace = idSchema.safeParse((await params).workspaceId);
  const search = new URL(request.url).searchParams;
  const target = targetQuery.safeParse(Object.fromEntries(search));
  if (!workspace.success || search.size !== 1 || !target.success) {
    return respond({ error: "Select one saved factory definition." }, 400);
  }

  try {
    const access = await requireWorkspaceAccessById(workspace.data, { requireManager: true });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const { currentMember, supabase, workspace: authorized } = access.context;
    const workspaceId = authorized.id;
    const { data: factory, error: factoryError } = await selectDefaultFactory(
      supabase,
      workspaceId,
    );
    if (factoryError) throw factoryError;
    if (!factory) return respond({ error: "Factory unavailable." }, 404);

    const { data: targetRow, error: targetError } = await selectStoredFactoryDefinition(
      supabase,
      workspaceId,
      factory.id,
      target.data,
    );
    if (targetError) throw targetError;
    if (!targetRow) return respond({ error: "Saved factory definition unavailable." }, 404);
    const definition = readVerifiedFactoryDefinition(
      targetRow.definition_json,
      targetRow.canonical_digest,
    );
    if (!definition) return respond({ error: "Saved factory definition unavailable." }, 422);

    const effective = resolveFactoryExecutionProfile(definition, currentMember.id);
    const authority = effective.credentialAuthority;
    const profile = {
      provider: effective.provider,
      model: effective.model,
      effort: effective.effort,
      maxTurns: effective.maxTurns,
      sandboxProvider: effective.sandboxProvider,
      credentialAuthority:
        authority.kind === "human"
          ? authority
          : {
              kind: authority.kind,
              grantId: authority.grantId,
              grantVersion: authority.grantVersion,
              bindingId: authority.bindingId,
            },
    } satisfies FactoryEditorExecutionProfileResponse["profile"];
    if (effective.unavailableReason) {
      return respond({
        profile,
        readiness: { status: "unavailable", reason: effective.unavailableReason },
      } satisfies FactoryEditorExecutionProfileResponse);
    }

    const admin = createSupabaseAdminClient();
    const [credential, sandbox] = await Promise.all([
      checkFactoryProfileCredentialReadiness({
        admin,
        workspaceId,
        factoryId: factory.id,
        profile: effective,
      }),
      checkSandboxReadiness({
        admin,
        workspaceId,
        repositoryId: definition.repositoryId,
        digest: targetRow.canonical_digest,
        profile,
      }),
    ]);
    return respond({
      profile,
      readiness: { status: "checked", credential, sandbox },
    } satisfies FactoryEditorExecutionProfileResponse);
  } catch {
    return respond({ error: "Could not load the effective execution profile." }, 500);
  }
}
