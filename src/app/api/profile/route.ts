import { NextResponse } from "next/server";

import {
  buildProfileAvatarPath,
  getProfileAvatarUrl,
  profileAvatarBucket,
  validateProfileAvatarBytes,
  validateProfileAvatarFile,
} from "@/lib/storage/profile-avatar";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  updateOwnProfileFormSchema,
  updateOwnProfileSchema,
  type ProfileAvatarAction,
} from "@/lib/workspace-members/contracts";

type ParsedProfileUpdate = {
  avatarAction: ProfileAvatarAction;
  file: File | null;
  fullName: string;
};

async function parseProfileUpdate(
  request: Request,
): Promise<{ data: ParsedProfileUpdate; error?: never } | { data?: never; error: string }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    const payload = await request.json().catch(() => null);
    const parsed = updateOwnProfileSchema.safeParse(payload);

    return parsed.success
      ? { data: { avatarAction: "keep", file: null, fullName: parsed.data.fullName } }
      : { error: parsed.error.issues[0]?.message ?? "Profile input is invalid." };
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return { error: "Profile input is invalid." };
  }

  const parsed = updateOwnProfileFormSchema.safeParse({
    avatarAction: formData.get("avatarAction"),
    fullName: formData.get("fullName"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Profile input is invalid." };
  }

  const fileValue = formData.get("file");
  const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : null;

  if (parsed.data.avatarAction === "replace" && !file) {
    return { error: "Select an image before replacing your profile photo." };
  }

  if (parsed.data.avatarAction !== "replace" && file) {
    return { error: "An image can only be sent when replacing your profile photo." };
  }

  if (file) {
    try {
      validateProfileAvatarFile(file);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Profile photo upload is invalid.",
      };
    }
  }

  return { data: { ...parsed.data, file } };
}

async function removeAvatarObject(path: string, context: string) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.storage.from(profileAvatarBucket).remove([path]);

  if (error) {
    console.error(`[profile-avatar] ${context}`, { error, path });
  }
}

export async function PATCH(request: Request) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Sign in before updating your profile." }, { status: 401 });
  }

  const parsed = await parseProfileUpdate(request);

  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const update = parsed.data;

  const admin = createSupabaseAdminClient();
  let uploadedPath: string | null = null;
  let nextAvatarPath: string | null = null;
  let nextAvatarUrl: string | null = null;

  if (update.avatarAction === "replace" && update.file) {
    let uploadBytes: Buffer;
    try {
      uploadBytes = Buffer.from(await update.file.arrayBuffer());
      validateProfileAvatarBytes(update.file, uploadBytes);
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Profile photo upload is invalid.",
        },
        { status: 400 },
      );
    }

    uploadedPath = buildProfileAvatarPath(user.id, update.file);
    const uploadResult = await admin.storage
      .from(profileAvatarBucket)
      .upload(uploadedPath, uploadBytes, {
        contentType: update.file.type,
        upsert: false,
      });

    if (uploadResult.error) {
      return NextResponse.json(
        { error: "Wallie could not upload your profile photo right now." },
        { status: 500 },
      );
    }

    nextAvatarPath = uploadedPath;
    nextAvatarUrl = getProfileAvatarUrl(uploadedPath);
  } else if (update.avatarAction === "remove") {
    nextAvatarPath = null;
    nextAvatarUrl = null;
  }

  const avatarChanged = update.avatarAction !== "keep";
  const { data: savedProfiles, error } = await admin.rpc("update_user_profile", {
    actor_avatar_changed: avatarChanged,
    // PostgREST function arguments are typed as strings even though SQL text
    // accepts null. Empty strings are normalized to null by the RPC for remove.
    actor_avatar_path: avatarChanged ? (nextAvatarPath ?? "") : undefined,
    actor_avatar_url: avatarChanged ? (nextAvatarUrl ?? "") : undefined,
    actor_full_name: update.fullName,
    actor_user_id: user.id,
  });

  if (error) {
    if (uploadedPath) {
      await removeAvatarObject(uploadedPath, "failed to clean up a rejected upload");
    }

    return NextResponse.json(
      { error: "Wallie could not update your profile right now." },
      { status: 500 },
    );
  }

  const savedProfile = Array.isArray(savedProfiles) ? savedProfiles[0] : savedProfiles;
  if (savedProfile?.superseded_avatar_path) {
    await removeAvatarObject(
      savedProfile.superseded_avatar_path,
      "failed to remove the previous profile photo",
    );
  }

  return NextResponse.json(
    {
      profile: {
        avatarUrl: savedProfile?.saved_avatar_url ?? nextAvatarUrl,
        fullName: savedProfile?.saved_full_name ?? update.fullName,
      },
    },
    { status: 200 },
  );
}
