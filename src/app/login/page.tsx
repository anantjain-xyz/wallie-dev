import { redirect } from "next/navigation";

import { AuthEntryPanel } from "@/components/auth/auth-entry-panel";
import {
  ensureProfileForUser,
  normalizeNextPath,
  resolveAuthenticatedHomePath,
} from "@/lib/auth";
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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    await ensureProfileForUser(supabase, user);
    redirect(await resolveAuthenticatedHomePath(supabase));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-8 sm:px-6 lg:px-8">
      <AuthEntryPanel
        errorCode={errorCode}
        mode="login"
        next={next}
        statusCode={statusCode}
      />
    </main>
  );
}
