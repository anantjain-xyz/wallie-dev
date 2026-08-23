import "server-only";

import { randomUUID } from "node:crypto";

import { validateProfileAvatarFile } from "@/lib/storage/profile-avatar-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const profileAvatarBucket = "profile-avatars";
export { validateProfileAvatarFile };

function getFileExtension(file: File) {
  switch (file.type) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

export function buildProfileAvatarPath(userId: string, file: File) {
  return `${userId}/${randomUUID()}.${getFileExtension(file)}`;
}

export function getProfileAvatarUrl(path: string) {
  const supabase = createSupabaseAdminClient();
  const {
    data: { publicUrl },
  } = supabase.storage.from(profileAvatarBucket).getPublicUrl(path);

  return publicUrl;
}
