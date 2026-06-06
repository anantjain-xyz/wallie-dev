import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";

function getEntryPath(next: string, error: string) {
  const basePath = loginPath(next);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}error=${error}`;
}

export async function GET(request: NextRequest) {
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  return NextResponse.redirect(new URL(getEntryPath(next, "invalid_provider"), request.url), {
    status: 303,
  });
}
