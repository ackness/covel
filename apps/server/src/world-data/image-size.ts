import { open } from "node:fs/promises";

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** A JPEG's frame header can sit behind large EXIF and ICC segments. */
const HEADER_BYTES = 512 * 1024;

function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null;
  const format = bytes.toString("latin1", 12, 16);
  if (format === "VP8X")
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  if (format === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8 ")
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  return null;
}

function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Fill bytes before a marker, and markers that carry no segment.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // Start-of-frame markers, without the table and arithmetic ones among them.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame)
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/** Pixel size of a PNG, JPEG or WebP from its header; null when it has none. */
export function imageSizeOf(bytes: Buffer): ImageSize | null {
  let size: ImageSize | null = null;
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47)
    size = pngSize(bytes);
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
    size = jpegSize(bytes);
  else if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    size = webpSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

export async function readImageSize(
  filePath: string,
): Promise<ImageSize | null> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return imageSizeOf(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
