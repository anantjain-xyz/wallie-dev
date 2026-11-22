import "server-only";

import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

import { diagnosisReceiptSchema } from "./contracts";

export function diagnosisResponse(value: unknown, status = 200) {
  return Response.json({ diagnosis: diagnosisReceiptSchema.parse(value) }, { status, headers });
}

export function diagnosisError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

export function diagnosisFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "42501":
      return diagnosisError("You do not have permission to manage this diagnosis.", 403);
    case "P0002":
      return diagnosisError("The failure cohort or diagnosis is unavailable.", 404);
    case "PT409":
    case "P0011":
      return diagnosisError("The factory or diagnosis changed. Refresh before retrying.", 409);
    case "22023":
    case "PT422":
      return diagnosisError(
        "The diagnosis requires current, scoped evidence and configuration.",
        422,
      );
    default:
      return diagnosisError("Could not process the factory diagnosis.", 500);
  }
}
