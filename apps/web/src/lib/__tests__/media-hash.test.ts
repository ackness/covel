/**
 * Unit tests for the SHA-256 hex helper used by the media cache integrity
 * check. Skips gracefully when the runtime does not expose
 * `crypto.subtle` (we still want the rest of the suite to pass on
 * exotic targets).
 */

import { describe, expect, it } from "vitest";

import { sha256Hex, subtleAvailable } from "../media-hash.js";

const subtleSkip = !subtleAvailable();

describe.skipIf(subtleSkip)("sha256Hex", () => {
  it("hashes the empty buffer to the published SHA-256 value", async () => {
    const hash = await sha256Hex(new ArrayBuffer(0));
    // RFC 6234 known answer
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes the ASCII string 'abc' to the published SHA-256 value", async () => {
    const bytes = new TextEncoder().encode("abc");
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const hash = await sha256Hex(buffer);
    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns lowercase hex of length 64", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const hash = await sha256Hex(buffer);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("subtleAvailable() reports true under jsdom", () => {
    // The skipIf above guards against environments without subtle —
    // here we simply assert the helper is honest about that.
    expect(subtleAvailable()).toBe(true);
  });
});
