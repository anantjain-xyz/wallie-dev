import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { LandingPage } from "@/components/landing/landing-page";
import { ensureProfileForUser, resolveAuthenticatedHomePath } from "@/lib/auth";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function hasSupabaseSessionCookie(cookieStore: { getAll: () => { name: string }[] }) {
  return cookieStore
    .getAll()
    .some(({ name }) => name.startsWith("sb-") && name.includes("-auth-token"));
}

function hasSupabasePublicEnv(input: Record<string, string | undefined>) {
  return Boolean(input.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && input.NEXT_PUBLIC_SUPABASE_URL);
}

export default async function HomePage() {
  const cookieStore = await cookies();

  if (!hasSupabaseSessionCookie(cookieStore) || !hasSupabasePublicEnv(process.env)) {
    return <LandingPage />;
  }

  const supabase = await createSupabaseServerClient(process.env, cookieStore);
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return <LandingPage />;
  }

  await ensureProfileForUser(supabase, user);

  redirect(await resolveAuthenticatedHomePath(supabase));
}
