import { randomUUID } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const workspaceAvatarBucket = "workspace-avatars";
export const maxWorkspaceAvatarBytes = 2 * 1024 * 1024;
export const allowedWorkspaceAvatarMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

function getFileExtension(file: File) {
  const nameParts = file.name.split(".");
  const fileNameExtension =
    nameParts.length > 1 ? nameParts[nameParts.length - 1]?.toLowerCase() : null;

  if (fileNameExtension) {
    return fileNameExtension;
  }

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

export function buildWorkspaceAvatarPath(workspaceId: string, file: File) {
  return `${workspaceId}/${randomUUID()}.${getFileExtension(file)}`;
}

export function validateWorkspaceAvatarFile(file: File) {
  if (
    !allowedWorkspaceAvatarMimeTypes.includes(
      file.type as (typeof allowedWorkspaceAvatarMimeTypes)[number],
    )
  ) {
    throw new Error("Upload a PNG, JPEG, or WebP image.");
  }

  if (file.size > maxWorkspaceAvatarBytes) {
    throw new Error("Workspace avatars must stay under 2 MB.");
  }
}

export function getWorkspaceAvatarUrl(path: string | null) {
  if (!path) {
    return null;
  }

  const supabase = createSupabaseAdminClient();
  const {
    data: { publicUrl },
  } = supabase.storage.from(workspaceAvatarBucket).getPublicUrl(path);

  return publicUrl;
}
