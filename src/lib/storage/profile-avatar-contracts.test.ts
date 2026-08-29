import { describe, expect, it } from "vitest";

import { validateProfileAvatarBytes } from "./profile-avatar-contracts";

function imageFile(bytes: number[], type: "image/jpeg" | "image/png" | "image/webp") {
  const contents = Uint8Array.from(bytes);
  return {
    bytes: contents,
    file: new File([contents], `avatar.${type.split("/")[1]}`, { type }),
  };
}

describe("validateProfileAvatarBytes", () => {
  it.each([
    ["JPEG", [0xff, 0xd8, 0xff], "image/jpeg"],
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["WebP", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
  ] as const)("accepts %s signature bytes", (_label, bytes, type) => {
    const image = imageFile([...bytes], type);
    expect(() => validateProfileAvatarBytes(image.file, image.bytes)).not.toThrow();
  });

  it("rejects content that does not match its declared image type", () => {
    const image = imageFile([0x6e, 0x6f, 0x74, 0x2d, 0x70, 0x6e, 0x67], "image/png");
    expect(() => validateProfileAvatarBytes(image.file, image.bytes)).toThrow(
      "The file contents do not match the selected image type.",
    );
  });

  it("rejects inconsistent uploaded byte lengths", () => {
    const image = imageFile([0xff, 0xd8, 0xff], "image/jpeg");
    expect(() => validateProfileAvatarBytes(image.file, image.bytes.subarray(0, 2))).toThrow(
      "The uploaded image size was inconsistent.",
    );
  });
});
