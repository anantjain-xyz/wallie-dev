import { permanentRedirect } from "next/navigation";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { readFirstValue } from "@/lib/utils";

type SignupPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function authEntryPath(next: string, error?: string, status?: string) {
  const path = loginPath(next);
  const params = new URLSearchParams();

  if (error) {
    params.set("error", error);
  }

  if (status) {
    params.set("status", status);
  }

  const serialized = params.toString();

  if (!serialized) {
    return path;
  }

  return `${path}${path.includes("?") ? "&" : "?"}${serialized}`;
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const resolvedSearchParams = await searchParams;
  const next = normalizeNextPath(readFirstValue(resolvedSearchParams.next));
  const errorCode = readFirstValue(resolvedSearchParams.error);
  const statusCode = readFirstValue(resolvedSearchParams.status);

  permanentRedirect(authEntryPath(next, errorCode, statusCode));
}
