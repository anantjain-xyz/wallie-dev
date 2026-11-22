import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import {
  failureCohortIdSchema,
  failureCohortReviewSchema,
} from "@/lib/factory-failures/cohort-contracts";
import { reviewFailureCohort } from "@/lib/factory-failures/cohorts";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; cohortId: string }>;
};

const failures = {
  "42501": [403, "You do not have permission to review this failure group."],
  P0002: [404, "The failure group is unavailable."],
  P0011: [409, "This factory is archived."],
  PT409: [409, "The failure group changed. Reload it before saving a review."],
  "22023": [422, "Check the review fields and the runs selected for the split."],
} as const;

function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const parsedParams = await params;
  const id = failureCohortIdSchema.safeParse(parsedParams.cohortId);
  if (!id.success) return failure(400, "Provide a valid failure group ID.");

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const raw = await readBoundedJsonBody(request, 8 * 1024);
    if (!raw.ok) {
      switch (raw.code) {
        case "request_too_large":
          return failure(413, "The review request is too large.");
        case "unsupported_media_type":
          return failure(415, "Send the review as JSON.");
        case "invalid_request":
          return failure(400, "The review request could not be read.");
      }
    }
    const command = failureCohortReviewSchema.safeParse(raw.body);
    if (!command.success) return failure(400, "Check the failure group review fields.");

    const result = await reviewFailureCohort(
      context.access.supabase,
      context,
      id.data,
      command.data,
    );
    return Response.json(result, { headers });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    for (const [key, response] of Object.entries(failures)) {
      if (key === code) return failure(response[0], response[1]);
    }
    return failure(500, "Could not save the failure group review.");
  }
}
