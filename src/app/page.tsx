import { redirect } from "next/navigation";

import {
  ensureProfileForUser,
  resolveAuthenticatedHomePath,
} from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(loginPath("/"));
  }

  await ensureProfileForUser(supabase, user);

  redirect(await resolveAuthenticatedHomePath(supabase));
}
