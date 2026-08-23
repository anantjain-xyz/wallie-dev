export const maxProfileAvatarBytes = 2 * 1024 * 1024;
export const allowedProfileAvatarMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

export function validateProfileAvatarFile(file: File) {
  if (
    !allowedProfileAvatarMimeTypes.includes(
      file.type as (typeof allowedProfileAvatarMimeTypes)[number],
    )
  ) {
    throw new Error("Upload a PNG, JPEG, or WebP image.");
  }

  if (file.size === 0) {
    throw new Error("The selected image is empty.");
  }

  if (file.size > maxProfileAvatarBytes) {
    throw new Error("Profile photos must stay under 2 MB.");
  }
}
