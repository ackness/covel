const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Read the small part of PNG structure the authoring pipeline depends on.
 * This intentionally avoids an image-decoder dependency: dimensions and
 * transparency capability are declared by IHDR / tRNS before pixel data.
 *
 * @param {Buffer | Uint8Array} input
 */
export function inspectPng(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("generated image is not a valid PNG file");
  }

  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.toString("ascii", 12, 16);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    throw new Error("generated PNG has no valid IHDR chunk");
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  let hasTransparencyChunk = false;

  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > bytes.length) {
      throw new Error("generated PNG contains a truncated chunk");
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") hasTransparencyChunk = true;
    offset = next;
    if (type === "IEND") break;
  }

  return {
    width,
    height,
    hasTransparency: colorType === 4 || colorType === 6 || hasTransparencyChunk,
  };
}

/**
 * Reject provider output that cannot satisfy the portrait manifest before it
 * overwrites a checked-in asset.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {{ size: string, background?: string, label?: string }} expected
 */
export function assertPortraitPng(bytes, expected) {
  const label = expected.label ?? "portrait";
  const match = /^(\d+)x(\d+)$/.exec(expected.size);
  if (!match)
    throw new Error(`invalid requested portrait size: ${expected.size}`);

  const image = inspectPng(bytes);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `${label} has ${image.width}x${image.height}; expected ${width}x${height}`,
    );
  }
  if (expected.background === "transparent" && !image.hasTransparency) {
    throw new Error(`${label} has no PNG alpha channel; expected transparency`);
  }
  return image;
}
