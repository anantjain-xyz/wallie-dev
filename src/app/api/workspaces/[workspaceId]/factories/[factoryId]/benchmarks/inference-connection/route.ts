import { z } from "zod";

import { benchmarkReplayImageProfileSchema, parseServerEnv } from "@/env/server";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { readBenchmarkCommand } from "../mutation-responses";

const id = z.string().uuid();
const connectionSchema = z.object({
  id,
  sandboxConnectionRevision: id,
  profile: benchmarkReplayImageProfileSchema,
  createdAt: z.string().datetime({ offset: true }),
});
const commands = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("connect"),
      apiKey: z
        .string()
        .trim()
        .min(20)
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z.object({ action: z.literal("revoke"), connectionRevision: id }).strict(),
]);

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

function connectionError(code?: string) {
  if (code === "42501")
    return Response.json(
      { error: "Factory manager access is required." },
      { status: 403, headers },
    );
  if (code === "PT422")
    return Response.json(
      { error: "Connect Vercel Sandbox before saving benchmark inference." },
      { status: 422, headers },
    );
  if (code === "P0002")
    return Response.json({ error: "The factory is unavailable." }, { status: 404, headers });
  if (code === "P0011")
    return Response.json({ error: "The factory is archived." }, { status: 409, headers });
  return Response.json(
    { error: "Could not manage the benchmark inference connection." },
    { status: 500, headers },
  );
}

export async function GET(request: Request, { params }: Context) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const { data, error } = await createSupabaseAdminClient()
      .rpc("read_factory_benchmark_inference_connection", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_actor_user_id: context.access.user.id,
      })
      .abortSignal(request.signal);
    if (error) return connectionError(error.code);
    return Response.json({ connection: connectionSchema.nullable().parse(data) }, { headers });
  } catch {
    return connectionError();
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const command = await readBenchmarkCommand(
      request,
      commands,
      "Provide a dedicated OpenAI key or an exact connection revision.",
      4096,
    );
    if (!command.ok) return command.response;
    const scope = {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
    };
    const admin = createSupabaseAdminClient();
    if (command.data.action === "revoke") {
      const { data, error } = await admin
        .rpc("revoke_factory_benchmark_inference_connection", {
          ...scope,
          p_connection_revision: command.data.connectionRevision,
        })
        .abortSignal(request.signal);
      if (error) return connectionError(error.code);
      return Response.json({ revoked: data === true }, { headers });
    }
    const profile = parseServerEnv().WALLIE_BENCHMARK_LIVE_IMAGE_PROFILE;
    if (!profile) {
      return Response.json(
        { error: "The managed live replay image is unavailable." },
        { status: 412, headers },
      );
    }
    const { data, error } = await admin
      .rpc("configure_factory_benchmark_inference_connection", {
        ...scope,
        p_encrypted_api_key: encryptSecretValue(command.data.apiKey),
        p_profile: profile,
      })
      .abortSignal(request.signal);
    if (error) return connectionError(error.code);
    return Response.json({ connection: connectionSchema.parse(data) }, { status: 201, headers });
  } catch {
    return connectionError();
  }
}
