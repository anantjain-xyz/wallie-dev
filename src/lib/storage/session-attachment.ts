import "server-only";

import { randomUUID } from "node:crypto";

import {
  allowedSessionAttachmentMimeTypes,
  maxSessionAttachmentBytes,
  type SessionAttachmentMimeType,
} from "@/lib/storage/contracts";

export const sessionAttachmentBucket = "session-attachments";
export const sessionAttachmentExpiryMs = 24 * 60 * 60 * 1000;

export function createSessionAttachmentIdentity(workspaceId: string, contentType: string) {
  const id = randomUUID();
  return {
    id,
    storagePath: `${workspaceId}/${id}.${extensionForContentType(contentType)}`,
  };
}

export function normalizeSessionAttachmentFileName(fileName: string, contentType: string) {
  const leafName = fileName.split(/[\\/]/).pop() ?? "";
  const normalized = leafName.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || `image.${extensionForContentType(contentType)}`).slice(0, 255);
}

export function validateSessionAttachmentFile(file: File, bytes: Buffer) {
  if (!allowedSessionAttachmentMimeTypes.includes(file.type as SessionAttachmentMimeType)) {
    throw new Error("Upload a PNG, JPEG, or WebP image.");
  }

  if (file.size < 1 || bytes.length < 1) {
    throw new Error("The selected image is empty.");
  }

  if (file.size > maxSessionAttachmentBytes || bytes.length > maxSessionAttachmentBytes) {
    throw new Error("Session images must stay under 4 MB each.");
  }

  if (file.size !== bytes.length) {
    throw new Error("The uploaded image size was inconsistent.");
  }

  if (!hasExpectedImageSignature(bytes, file.type as SessionAttachmentMimeType)) {
    throw new Error("The file contents do not match the selected image type.");
  }
}

export function extensionForContentType(contentType: string) {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new Error("Unsupported session image type.");
  }
}

function hasExpectedImageSignature(bytes: Buffer, contentType: SessionAttachmentMimeType) {
  switch (contentType) {
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}
