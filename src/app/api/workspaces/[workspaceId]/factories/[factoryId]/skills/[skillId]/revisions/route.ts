import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import {
  factorySkillRevisionIdSchema,
  saveFactorySkillRevisionSchema,
} from "@/lib/factory-skills/contracts";
import {
  listFactorySkillRevisions,
  revokeFactorySkillRevision,
  saveFactorySkillRevision,
} from "@/lib/factory-skills/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; skillId: string }>;
};
const querySchema = z
  .object({
    beforeRevisionNumber: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(20).default(20),
  })
  .strict();
const revokeSchema = z.object({ revisionId: factorySkillRevisionIdSchema }).strict();
const skillIdSchema = z.string().uuid();

function skillRevisionError(error: unknown, fallback: string) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return Response.json(
    {
      error: code === "PT409" ? "The skill changed. Reload its revisions before saving." : fallback,
    },
    { status: factoryErrorStatus(typeof code === "string" ? code : undefined), headers },
  );
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const skillId = skillIdSchema.safeParse((await params).skillId);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!skillId.success || !query.success) {
    return Response.json({ error: "Invalid skill revision request." }, { status: 400, headers });
  }
  const result = await listFactorySkillRevisions(context.access.supabase, {
    ...context,
    skillId: skillId.data,
    ...query.data,
  });
  return Response.json(result, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const skillId = skillIdSchema.safeParse((await params).skillId);
  const command = saveFactorySkillRevisionSchema.safeParse(await request.json().catch(() => null));
  if (!skillId.success || !command.success) {
    return Response.json(
      { error: "Provide a valid skill ID, expected revision, and content." },
      { status: 400, headers },
    );
  }
  try {
    const revision = await saveFactorySkillRevision(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      skillId: skillId.data,
      ...command.data,
    });
    return Response.json({ revision }, { status: 201, headers });
  } catch (error) {
    return skillRevisionError(error, "Could not save the skill revision.");
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const skillId = skillIdSchema.safeParse((await params).skillId);
  const command = revokeSchema.safeParse(await request.json().catch(() => null));
  if (!skillId.success || !command.success) {
    return Response.json(
      { error: "Provide a valid skill ID and revision ID." },
      { status: 400, headers },
    );
  }
  try {
    const revision = await revokeFactorySkillRevision(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      skillId: skillId.data,
      revisionId: command.data.revisionId,
    });
    return Response.json({ revision }, { headers });
  } catch (error) {
    return skillRevisionError(error, "Could not revoke the skill revision.");
  }
}
