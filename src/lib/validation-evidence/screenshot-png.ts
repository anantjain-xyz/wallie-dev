import "server-only";

import { deflateSync, inflateSync } from "node:zlib";

import { MAX_BROWSER_SCREENSHOT_BYTES } from "./browser-contract";

const MAX_WIDTH = 960;
const MAX_HEIGHT = 540;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let code = index;
  for (let bit = 0; bit < 8; bit++) {
    code = (code >>> 1) ^ (code & 1 ? 0xedb88320 : 0);
  }
  return code;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(type: string, bytes: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + bytes.length);
  chunk.writeUInt32BE(bytes.length);
  chunk.write(type, 4, "ascii");
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + bytes.length)), 8 + bytes.length);
  return chunk;
}

/** Verify and re-encode bounded Chromium RGB(A) pixels, discarding all metadata. */
export function sanitizeBrowserScreenshot(bytes: Buffer): Buffer | null {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > MAX_BROWSER_SCREENSHOT_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return null;
  }

  let header: Buffer | null = null;
  const imageData: Buffer[] = [];
  let offset = 8;
  let finished = false;
  let closedImage = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) return null;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return null;
    if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return null;
    const data = bytes.subarray(offset + 8, end);

    if (!header && type !== "IHDR") return null;
    if (type === "IHDR") {
      if (header || length !== 13) return null;
      header = data;
    } else if (type === "IDAT") {
      if (closedImage) return null;
      imageData.push(data);
    } else if (type === "IEND") {
      finished = length === 0 && end + 4 === bytes.length;
      break;
    } else {
      if (type[0] === type[0].toUpperCase() || ["acTL", "fcTL", "fdAT", "tRNS"].includes(type)) {
        return null;
      }
      closedImage = imageData.length > 0;
    }
    offset = end + 4;
  }

  if (!header || !finished || !imageData.length) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = header[9] === 2 ? 3 : header[9] === 6 ? 4 : 0;
  if (
    width === 0 ||
    width > MAX_WIDTH ||
    height === 0 ||
    height > MAX_HEIGHT ||
    channels === 0 ||
    header[8] !== 8 ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    header[12] !== 0
  ) {
    return null;
  }
  const rowSize = width * channels + 1;
  const expectedSize = rowSize * height;
  try {
    const rows = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedSize });
    if (rows.length !== expectedSize) return null;
    for (let row = 0; row < rows.length; row += rowSize) {
      if (rows[row] > 4) return null;
    }
    const sanitized = Buffer.concat([
      PNG_SIGNATURE,
      writeChunk("IHDR", header),
      writeChunk("IDAT", deflateSync(rows)),
      writeChunk("IEND", Buffer.alloc(0)),
    ]);
    return sanitized.length <= MAX_BROWSER_SCREENSHOT_BYTES ? sanitized : null;
  } catch {
    return null;
  }
}
