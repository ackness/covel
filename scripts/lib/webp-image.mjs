import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectPng } from "./png-image-validation.mjs";

const run = promisify(execFile);

/**
 * Settings of every portrait and scene a world ships: lossy colour at quality
 * 90 with a lossless alpha plane, so a sprite keeps its exact edge.
 */
const CWEBP_ARGS = ["-quiet", "-q", "90", "-alpha_q", "100", "-m", "6"];

/**
 * Encode a PNG as the WebP a world package ships. Needs the `cwebp` program
 * (libwebp) on PATH; this keeps an image codec out of the dependencies.
 *
 * @param {Buffer | Uint8Array} png
 * @returns {Promise<Buffer>}
 */
export async function encodeWebp(png) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "covel-webp-"));
  const input = path.join(directory, "in.png");
  const output = path.join(directory, "out.webp");
  try {
    await writeFile(input, png);
    try {
      await run("cwebp", [...CWEBP_ARGS, "-sharp_yuv", input, "-o", output]);
    } catch (error) {
      if (error?.code === "ENOENT")
        throw new Error(
          "cwebp is not installed; install libwebp (`brew install webp`, `apt install webp`)",
          { cause: error },
        );
      throw error;
    }
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Read the size and the alpha flag from a WebP header. No pixel is decoded.
 *
 * @param {Buffer | Uint8Array} input
 */
export function inspectWebp(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (
    bytes.length < 30 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    throw new Error("image is not a valid WebP file");
  }
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
      hasTransparency: (bytes[20] & 0x10) !== 0,
    };
  }
  if (chunk === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      hasTransparency: false,
    };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      hasTransparency: ((bits >>> 28) & 1) === 1,
    };
  }
  throw new Error(`WebP file starts with an unknown chunk: ${chunk}`);
}

/**
 * Size, alpha flag and MIME type of a world picture, by its file extension:
 * WebP is what the bundled worlds ship, PNG stays valid for a world of your own.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {string} filename
 */
export function inspectWorldImage(bytes, filename) {
  return /\.webp$/i.test(filename)
    ? { ...inspectWebp(bytes), mime: "image/webp" }
    : { ...inspectPng(bytes), mime: "image/png" };
}
