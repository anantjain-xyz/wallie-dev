import { factoryAutomationPathSchema } from "@/lib/factory-automations/contracts";
import {
  automationDryRunNamesHeader,
  automationDryRunRequestSchema,
} from "@/lib/factory-automations/dry-run-contracts";
import {
  automationError,
  automationResponse,
  readAutomationCommand,
} from "@/lib/factory-automations/http";
import { dryRunFactoryAutomation } from "@/lib/factory-automations/service";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";

type Context = {
  params: Promise<{ workspaceId: string; factoryId: string; automationId: string }>;
};

export async function POST(request: Request, { params }: Context) {
  const path = factoryAutomationPathSchema.safeParse(await params);
  if (!path.success) return automationResponse({ error: "Provide a valid automation ID." }, 400);
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(path.data));
    if (!context.ok) return context.response;
    const input = await readAutomationCommand(request, automationDryRunRequestSchema);
    if (!input.ok) return input.response;
    const { supabase } = context.access;
    const result = await dryRunFactoryAutomation(supabase, path.data, input.command);
    if (!result) return automationResponse({ error: "Automation revision not found." }, 404);
    if (request.headers.get(automationDryRunNamesHeader) !== "1") return automationResponse(result);
    const signal = AbortSignal.timeout(3_000);
    const [payer, policy] = await Promise.allSettled([
      supabase
        .from("workspace_members")
        .select("full_name")
        .eq("workspace_id", path.data.workspaceId)
        .eq("id", result.budgetPayerMemberId)
        .abortSignal(signal)
        .maybeSingle(),
      result.assignment.status === "eligible"
        ? supabase
            .from("execution_policy_revisions")
            .select("revision")
            .eq("workspace_id", path.data.workspaceId)
            .eq("id", result.assignment.executionPolicyRevisionId)
            .abortSignal(signal)
            .maybeSingle()
        : null,
    ]);
    return automationResponse({
      ...result,
      names: {
        budgetPayer:
          payer.status === "fulfilled" ? payer.value.data?.full_name?.trim() || null : null,
        executionPolicyRevision:
          policy.status === "fulfilled" ? (policy.value?.data?.revision ?? null) : null,
      },
    });
  } catch (error) {
    return automationError(error);
  }
}
