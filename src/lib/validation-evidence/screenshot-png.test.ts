import { describe, expect, it } from "vitest";
import { sanitizeBrowserScreenshot } from "./screenshot-png";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC";
const withMetadata =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAI3RFWHRjcmVkZW50aWFsAHN5bnRoZXRpYyB2aXNpYmxlIGNhbmFyeZ12gdQAAAAMSURBVHicYxBUMgYAAK4AZxUeoV8AAAAASUVORK5CYII=";

describe("trusted screenshot PNG normalization", () => {
  it("keeps Chromium-compatible pixel data and removes ancillary metadata", () => {
    expect(sanitizeBrowserScreenshot(Buffer.from(withMetadata, "base64"))).toEqual(
      Buffer.from(png, "base64"),
    );
  });

  it.each([
    "not a picture",
    // The same pixel with an out-of-viewport width.
    "iVBORw0KGgoAAAANSUhEUgAAA8EAAAABCAIAAABxKjt+AAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC",
    // Invalid scanline filter or inflated row length.
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMVVDIGAADCAGyJlg/cAAAAAElFTkSuQmCC",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGMQVDJ2AQABWQCrEyolqwAAAABJRU5ErkJggg==",
    // An animation chunk and a truncated end marker.
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACGFjVEwAAAABAAAAALQt6aAAAAAMSURBVHicYxBUMgYAAK4AZxUeoV8AAAAASUVORK5CYII=",
    png.slice(0, -8),
  ])("rejects malformed or unsupported media", (value) => {
    expect(sanitizeBrowserScreenshot(Buffer.from(value, "base64"))).toBeNull();
  });

  it("checks CRC integrity and rejects appended bytes", () => {
    const bytes = Buffer.from(png, "base64");
    expect(sanitizeBrowserScreenshot(Buffer.concat([bytes, Buffer.from([0])]))).toBeNull();
    bytes[45] ^= 0x80;
    expect(sanitizeBrowserScreenshot(bytes)).toBeNull();
  });
});
