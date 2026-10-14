import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MediaClaim } from "@covel/shared";
import { assertStoreIdentifiers, withoutNul } from "../common/without-nul.js";

export async function toBytes(blob: Uint8Array | Blob): Promise<Uint8Array> {
  if (blob instanceof Uint8Array) return new Uint8Array(blob);
  return new Uint8Array(await blob.arrayBuffer());
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mediaPath(root: string, id: string): string {
  return join(root, id.slice(0, 2), id.slice(2, 4), `${id}.bin`);
}

export function toMeta(
  meta?: object,
): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined
    ? undefined
    : withoutNul(structuredClone(meta as Record<string, unknown>));
}

export function bytesToReadableStream(
  bytes: Uint8Array,
): ReadableStream<Uint8Array> {
  // Copy to a fresh Uint8Array so the stream owner can't observe later mutations
  // of the source buffer.
  const copy = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

export function normalizeBytes(value: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

// filterAssetsByMetadata lives in ./filter.js; re-exported for the backends.
export { filterAssetsByMetadata } from "./filter.js";

/**
 * Check every identifier of a claim batch before the first write, so an
 * invalid claim late in the batch is refused the same way on every backend.
 */
export function assertMediaClaims(claims: readonly MediaClaim[]): void {
  assertStoreIdentifiers(claims);
}
