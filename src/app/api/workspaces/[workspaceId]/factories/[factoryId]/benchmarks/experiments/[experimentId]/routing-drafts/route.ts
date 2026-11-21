import { z } from "zod";

import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { createRoutingDraft } from "@/lib/model-routing/draft";
import {
  routingDraftRequestSchema,
  routingDraftResponseSchema,
} from "@/lib/model-routing/draft-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

import { readBenchmarkCommand } from "../../../mutation-responses";

const id = z.string().uuid().toLowerCase();
const pathSchema = z.object({ workspaceId: id, factoryId: id, experimentId: id });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; factoryId: string; experimentId: string }> },
) {
  const path = pathSchema.safeParse(await params);
  if (!path.success)
    return Response.json({ error: "Provide a valid comparison." }, { status: 400, headers });

  try {
    const access = await requireWorkspaceAccessById(path.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok)
      return Response.json({ error: access.error }, { status: access.status, headers });
    const command = await readBenchmarkCommand(
      request,
      routingDraftRequestSchema,
      "Review the routing task class and thresholds.",
      4096,
    );
    if (!command.ok) return command.response;

    const result = await createRoutingDraft(
      {
        ...path.data,
        admin: createSupabaseAdminClient(),
        actorUserId: access.context.user.id,
      },
      command.data,
    );
    return result.ok
      ? Response.json(
          routingDraftResponseSchema.parse({
            draftId: result.draftId,
            canonicalDigest: result.canonicalDigest,
          }),
          { status: 201, headers },
        )
      : Response.json(
          { error: result.diagnostics?.[0]?.message ?? result.error },
          { status: result.status, headers },
        );
  } catch {
    return Response.json(
      { error: "Could not create the routing draft." },
      { status: 500, headers },
    );
  }
}
