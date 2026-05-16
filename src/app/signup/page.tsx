import { permanentRedirect } from "next/navigation";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { readFirstValue } from "@/lib/utils";

type SignupPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const resolvedSearchParams = await searchParams;
  const next = normalizeNextPath(readFirstValue(resolvedSearchParams.next));

  permanentRedirect(loginPath(next));
}
