import { AuthenticationError, Cursor } from "@cursor/sdk";
import { NextResponse } from "next/server";

import {
  CursorNotConnectedError,
  getCursorCredentialForUser,
  markCursorReconnectRequired,
} from "@/lib/cursor/tokens";
import type { CursorCredential } from "@/lib/cursor/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  let credential: CursorCredential | null = null;
  try {
    credential = await getCursorCredentialForUser(admin, user.id);
    const models = await Cursor.models.list({ apiKey: credential.secret });
    return NextResponse.json({
      models: models
        .map((entry) => ({
          label: entry.displayName ?? entry.id,
          value: entry.id,
        }))
        .filter(
          (entry, index, all) => all.findIndex((item) => item.value === entry.value) === index,
        ),
    });
  } catch (error) {
    if (error instanceof AuthenticationError && credential) {
      await markCursorReconnectRequired(
        admin,
        user.id,
        credential.generation,
        "Cursor rejected the saved credential. Reconnect Cursor in Settings.",
      );
    }
    const status = error instanceof CursorNotConnectedError ? 409 : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Cursor models." },
      { status },
    );
  }
}
