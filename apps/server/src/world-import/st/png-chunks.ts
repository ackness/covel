import { StImportError } from "./report.js";

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_CARD_JSON_BYTES = 3 * 1024 * 1024;
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  );
}
interface Chunk {
  type: string;
  start: number;
  end: number;
  data: Uint8Array;
}
function walk(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes))
    throw new StImportError("png-invalid", "Invalid PNG signature");
  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let hasCard = false;
  while (offset < bytes.length) {
    if (chunks.length >= 4096)
      throw new StImportError("png-chunks-limit", "PNG exceeds 4096 chunks");
    if (bytes.length - offset < 12)
      throw new StImportError(
        "png-invalid",
        "Truncated PNG chunk header or CRC",
      );
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12)
      throw new StImportError(
        "png-invalid",
        "PNG chunk exceeds remaining bytes",
      );
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type))
      throw new StImportError("png-invalid", "Invalid PNG chunk type");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, start: offset, end: offset + 12 + length, data });
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator >= 1 && separator <= 79) {
        const keyword = Buffer.from(data.subarray(0, separator)).toString(
          "latin1",
        );
        hasCard ||= keyword === "chara" || keyword === "ccv3";
      }
    }
    offset += length + 12;
    if (type === "IEND") return chunks;
  }
  if (!hasCard) throw new StImportError("png-invalid", "PNG has no IEND");
  return chunks;
}
export function readPngTextChunks(
  bytes: Uint8Array,
): { keyword: string; text: string }[] {
  return walk(bytes)
    .filter((chunk) => chunk.type === "tEXt")
    .flatMap(({ data }) => {
      const separator = data.indexOf(0);
      if (separator < 1 || separator > 79) return [];
      return [
        {
          keyword: Buffer.from(data.subarray(0, separator)).toString("latin1"),
          text: Buffer.from(data.subarray(separator + 1)).toString("latin1"),
        },
      ];
    });
}
export function stripPngTextChunks(bytes: Uint8Array): Uint8Array {
  const chunks = walk(bytes);
  return Buffer.concat([
    PNG_SIGNATURE,
    ...chunks
      .filter(
        ({ type }) => !["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type),
      )
      .map(({ start, end }) => bytes.subarray(start, end)),
  ]);
}
export function extractCardJson(bytes: Uint8Array): {
  json: unknown;
  spec: "ccv3" | "chara";
} {
  const chunks = walk(bytes);
  const texts = readPngTextChunks(bytes);
  const card =
    texts.find(({ keyword }) => keyword === "ccv3") ??
    texts.find(({ keyword }) => keyword === "chara");
  if (!card)
    throw new StImportError(
      chunks.some(({ type }) => type === "zTXt" || type === "iTXt")
        ? "png-unsupported-text-chunk"
        : "png-no-card",
      "PNG has no supported card tEXt chunk",
    );
  if (card.text.length > Math.ceil(MAX_CARD_JSON_BYTES / 3) * 4 + 4096)
    throw new StImportError(
      "json-too-large",
      "Decoded card JSON exceeds 3 MiB",
    );
  if (!/^[A-Za-z0-9+/=\s]+$/.test(card.text))
    throw new StImportError("png-base64-invalid", "Invalid card base64");
  const compact = card.text.replace(/\s/g, "");
  if (compact.length > Math.ceil(MAX_CARD_JSON_BYTES / 3) * 4)
    throw new StImportError(
      "json-too-large",
      "Decoded card JSON exceeds 3 MiB",
    );
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    throw new StImportError(
      "png-base64-invalid",
      "Invalid card base64 padding",
    );
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length > MAX_CARD_JSON_BYTES)
    throw new StImportError(
      "json-too-large",
      "Decoded card JSON exceeds 3 MiB",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new StImportError("png-utf8-invalid", "Card JSON is not valid UTF-8");
  }
  try {
    return {
      json: JSON.parse(text) as unknown,
      spec: card.keyword as "ccv3" | "chara",
    };
  } catch {
    throw new StImportError("json-invalid", "Card JSON is invalid");
  }
}
