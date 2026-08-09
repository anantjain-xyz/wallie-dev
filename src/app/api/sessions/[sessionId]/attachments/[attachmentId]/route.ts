import { NextResponse } from "next/server";

import { sessionAttachmentReadParamsSchema } from "@/lib/storage/contracts";
import { sessionAttachmentBucket } from "@/lib/storage/session-attachment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ attachmentId: string; sessionId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const parsedParams = sessionAttachmentReadParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Attachment input is invalid." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Sign in before viewing session images." }, { status: 401 });
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", parsedParams.data.sessionId)
    .maybeSingle();
  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session) {
    return NextResponse.json({ error: "Session image not found." }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data: attachment, error: attachmentError } = await admin
    .from("session_attachments")
    .select("content_type, original_filename, storage_path")
    .eq("id", parsedParams.data.attachmentId)
    .eq("session_id", session.id)
    .eq("workspace_id", session.workspace_id)
    .eq("status", "attached")
    .maybeSingle();
  if (attachmentError) {
    return NextResponse.json({ error: "Wallie could not load that image." }, { status: 500 });
  }
  if (!attachment) {
    return NextResponse.json({ error: "Session image not found." }, { status: 404 });
  }

  const { data: image, error: downloadError } = await admin.storage
    .from(sessionAttachmentBucket)
    .download(attachment.storage_path);
  if (downloadError || !image) {
    return NextResponse.json({ error: "Wallie could not load that image." }, { status: 500 });
  }

  return new NextResponse(await image.arrayBuffer(), {
    headers: {
      "cache-control": "private, max-age=3600",
      "content-disposition": contentDisposition(attachment.original_filename),
      "content-type": attachment.content_type,
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });
}

function contentDisposition(fileName: string) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
