export const maxProfileAvatarBytes = 2 * 1024 * 1024;
export const allowedProfileAvatarMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
type ProfileAvatarMimeType = (typeof allowedProfileAvatarMimeTypes)[number];

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

export function validateProfileAvatarBytes(file: File, bytes: Uint8Array) {
  validateProfileAvatarFile(file);

  if (file.size !== bytes.byteLength) {
    throw new Error("The uploaded image size was inconsistent.");
  }

  if (!hasExpectedImageSignature(bytes, file.type as ProfileAvatarMimeType)) {
    throw new Error("The file contents do not match the selected image type.");
  }
}

function hasExpectedImageSignature(bytes: Uint8Array, contentType: ProfileAvatarMimeType) {
  switch (contentType) {
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes.length >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (expected, index) => bytes[index] === expected,
        )
      );
    case "image/webp":
      return bytes.length >= 12 && hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP");
  }
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string) {
  return Array.from(expected).every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}
