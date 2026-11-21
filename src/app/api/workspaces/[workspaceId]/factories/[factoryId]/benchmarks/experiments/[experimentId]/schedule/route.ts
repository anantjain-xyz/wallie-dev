import {
  BenchmarkScheduleError,
  benchmarkScheduleCommandSchema,
  benchmarkScheduleIdSchema,
  requestBenchmarkSchedule,
} from "@/lib/factory-benchmarks/schedule";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { wakeWorker } from "@/lib/worker/wake";

import { readBenchmarkCommand } from "../../../mutation-responses";

const maxScheduleBodyBytes = 2 * 1024 * 1024;

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; experimentId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  return handleRequest(request, context, "read");
}

export async function POST(request: Request, context: RouteContext) {
  return handleRequest(request, context, "mutate");
}

async function handleRequest(request: Request, { params }: RouteContext, mode: "read" | "mutate") {
  try {
    const experimentId = benchmarkScheduleIdSchema.safeParse((await params).experimentId);
    if (!experimentId.success) {
      return Response.json({ error: "Provide a valid experiment ID." }, { status: 400, headers });
    }
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const command =
      mode === "read"
        ? ({ ok: true, data: { action: "read" } } as const)
        : await readBenchmarkCommand(
            request,
            benchmarkScheduleCommandSchema,
            "Provide a valid benchmark schedule command with exact runner and fixture selections.",
            maxScheduleBodyBytes,
          );
    if (!command.ok) return command.response;

    const snapshot = await requestBenchmarkSchedule(
      {
        admin: createSupabaseAdminClient(),
        workspaceId: context.workspaceId,
        factoryId: context.factoryId,
        experimentId: experimentId.data,
        actorUserId: context.access.user.id,
        signal: request.signal,
      },
      command.data,
    );
    if (mode === "mutate") await wakeWorker();
    return Response.json(snapshot, { headers });
  } catch (error) {
    if (error instanceof BenchmarkScheduleError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "The benchmark schedule request failed." },
      { status: 500, headers },
    );
  }
}
