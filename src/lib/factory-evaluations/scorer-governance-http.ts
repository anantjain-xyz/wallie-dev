import "server-only";

import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import type { ScorerGovernanceActor } from "./scorer-governance";

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const failures: Record<string, { status: number; message: string }> = {
  "42501": { status: 403, message: "You do not have permission for this scorer action." },
  P0002: { status: 404, message: "The requested scorer or evaluation is unavailable." },
  P0011: { status: 409, message: "This factory is archived." },
  PT409: {
    status: 409,
    message: "Scorer governance settings changed or admission is paused. Reload before retrying.",
  },
  PT422: {
    status: 422,
    message: "The exact retained evidence required by this revision is unavailable.",
  },
  "22023": { status: 422, message: "The selected scorer action is invalid." },
};

type CommandScope = { workspaceId: string; factoryId: string };
type Admin = Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">;

export function scorerGovernanceFailure(
  error: unknown,
  fallback = "Could not apply the scorer action.",
) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const failure =
    typeof code === "string" && Object.hasOwn(failures, code) ? failures[code] : undefined;
  return Response.json(
    { error: failure?.message ?? fallback },
    { status: failure?.status ?? 500, headers },
  );
}

export async function handleScorerGovernanceCommand<Command>(
  request: Request,
  params: Promise<CommandScope>,
  targetId: string,
  schema: z.ZodType<Command>,
  apply: (
    client: Admin,
    scope: ScorerGovernanceActor,
    targetId: string,
    input: Command,
  ) => Promise<unknown>,
) {
  const target = id.safeParse(targetId);
  if (!target.success)
    return Response.json(
      { error: "Provide a valid scorer or evaluation ID." },
      { status: 400, headers },
    );
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const raw = await readBoundedJsonBody(request, 8 * 1024);
    if (!raw.ok && raw.code === "request_too_large") {
      return Response.json({ error: "The scorer request is too large." }, { status: 413, headers });
    }
    if (!raw.ok && raw.code === "unsupported_media_type") {
      return Response.json({ error: "Send the scorer action as JSON." }, { status: 415, headers });
    }
    const command = schema.safeParse(raw.ok ? raw.body : null);
    if (!command.success)
      return Response.json(
        { error: "Check the scorer action fields and try again." },
        { status: 400, headers },
      );
    const result = await apply(
      createSupabaseAdminClient(),
      {
        workspaceId: context.access.workspace.id,
        factoryId: context.factoryId,
        actorUserId: context.access.user.id,
      },
      target.data,
      command.data,
    );
    return Response.json(result, { headers });
  } catch (error) {
    return scorerGovernanceFailure(error);
  }
}
