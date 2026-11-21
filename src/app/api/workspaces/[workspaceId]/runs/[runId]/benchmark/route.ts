import { runCatalogItemParamsSchema } from "@/features/wallie/run-catalog-contracts";
import {
  BenchmarkCaptureError,
  loadBenchmarkCapturePreview,
  resolveBenchmarkCapture,
  saveBenchmarkCapture,
} from "@/lib/factory-benchmarks/capture";
import { benchmarkCaptureRequestSchema } from "@/lib/factory-benchmarks/capture-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string; runId: string }> };
const headers = { "Cache-Control": "private, no-store" };

async function handleBenchmarkCapture(
  params: RouteContext["params"],
  action: (scope: Awaited<ReturnType<typeof resolveBenchmarkCapture>>) => Promise<Response>,
) {
  const parsed = runCatalogItemParamsSchema.safeParse(await params);
  if (!parsed.success)
    return Response.json({ error: "Invalid benchmark source run." }, { status: 400, headers });

  try {
    const access = await requireWorkspaceAccessById(parsed.data.workspaceId);
    if (!access.ok)
      return Response.json({ error: access.error }, { status: access.status, headers });
    return await action(await resolveBenchmarkCapture(access.context, parsed.data.runId));
  } catch (error) {
    if (error instanceof BenchmarkCaptureError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Could not capture this benchmark run." },
      { status: 500, headers },
    );
  }
}

export async function GET(_request: Request, { params }: RouteContext) {
  return handleBenchmarkCapture(params, async (scope) =>
    Response.json(await loadBenchmarkCapturePreview(scope), { headers }),
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  return handleBenchmarkCapture(params, async (scope) => {
    const parsed = benchmarkCaptureRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        { error: "Choose a suite and provide acceptance criteria for this benchmark task." },
        { status: 400, headers },
      );
    }
    return Response.json(await saveBenchmarkCapture(scope, parsed.data), { headers });
  });
}
