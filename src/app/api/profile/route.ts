import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { updateOwnProfileSchema } from "@/lib/workspace-members/contracts";

export async function PATCH(request: Request) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Sign in before updating your name." }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = updateOwnProfileSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Profile input is invalid." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.rpc("update_user_display_name", {
    actor_full_name: parsed.data.fullName,
    actor_user_id: user.id,
  });

  if (error) {
    return NextResponse.json(
      { error: "Wallie could not update your name right now." },
      { status: 500 },
    );
  }

  return NextResponse.json({ profile: { fullName: parsed.data.fullName } }, { status: 200 });
}
