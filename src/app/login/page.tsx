import { redirect } from "next/navigation";

import { AuthEntryPanel } from "@/components/auth/auth-entry-panel";
import { SplashShell } from "@/components/auth/splash-shell";
import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readFirstValue } from "@/lib/utils";

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = await searchParams;
  const next = normalizeNextPath(readFirstValue(resolvedSearchParams.next));
  const errorCode = readFirstValue(resolvedSearchParams.error);
  const statusCode = readFirstValue(resolvedSearchParams.status);
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (user) {
    await ensureProfileForUser(supabase, user);
    redirect(await resolveAuthenticatedHomePath(supabase));
  }

  return (
    <SplashShell>
      <AuthEntryPanel errorCode={errorCode} mode="login" next={next} statusCode={statusCode} />
    </SplashShell>
  );
}
