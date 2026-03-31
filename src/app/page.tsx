import { redirect } from "next/navigation";

import {
  ensureProfileForUser,
  resolveAuthenticatedHomePath,
} from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    redirect(loginPath("/"));
  }

  await ensureProfileForUser(supabase, user);

  redirect(await resolveAuthenticatedHomePath(supabase));
}
