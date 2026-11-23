import { handleSentryAlert } from "@/lib/factory-monitoring/sentry";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bindingId: string }> },
) {
  return handleSentryAlert(request, (await params).bindingId);
}
