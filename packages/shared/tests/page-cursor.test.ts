import { describe, expect, it } from "vitest";
import { decodePageCursor, encodePageCursor } from "../src/index.js";

describe("opaque page cursors", () => {
  it("round-trips the internal keyset without exposing JSON", () => {
    const position = {
      createdAt: "2026-09-04T01:02:03.000Z",
      id: "消息/1",
    };
    const cursor = encodePageCursor(position);
    expect(cursor).not.toContain(position.createdAt);
    expect(decodePageCursor(cursor)).toEqual(position);
  });

  it("rejects malformed and unsupported cursors", () => {
    expect(decodePageCursor("not-base64")).toBeNull();
    const unsupported = btoa(
      JSON.stringify({ v: 2, createdAt: "2026-09-04", id: "1" }),
    );
    expect(decodePageCursor(unsupported)).toBeNull();
  });
});
