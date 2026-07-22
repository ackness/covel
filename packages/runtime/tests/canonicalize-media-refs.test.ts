/**
 * Unit coverage for the shared MediaRef canonicalizer (docs 02 §2 / §2.1).
 *
 * Exercises the scanner (nesting, arrays, same-id-in-many-places, false-shape
 * non-detection), the canonicalization overrides + diagnostics, and the full
 * ownership rejection matrix (not-found / not-owned / mime-mismatch).
 */

import { describe, it, expect } from "vitest";
import type { JsonValue } from "@covel/shared";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../src/media/canonicalize-media-refs.js";

const id = (c: string): string => c.repeat(64);
const SESSION = "sess-1";

interface Asset {
  readonly mime: string;
  readonly size: number;
  readonly refs: ReadonlySet<string>;
}

/** In-memory ownership store plus a lookup-call counter for dedup assertions. */
function makeStore(assets: Record<string, Asset>): {
  store: MediaOwnershipStore;
  lookups: () => number;
} {
  let lookupCalls = 0;
  return {
    lookups: () => lookupCalls,
    store: {
      async lookup(assetId) {
        lookupCalls += 1;
        const a = assets[assetId];
        return a ? { mime: a.mime, size: a.size } : null;
      },
      async isReferencedBy(assetId, sessionId) {
        return assets[assetId]?.refs.has(sessionId) ?? false;
      },
    },
  };
}

const owned = (mime: string, size: number): Asset => ({
  mime,
  size,
  refs: new Set([SESSION]),
});

describe("canonicalizeMediaRefs — scanner", () => {
  it("passes primitives and media-free structures through unchanged", async () => {
    const { store } = makeStore({});
    const value: JsonValue = { a: 1, b: ["x", null, { c: true }] };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.value).toEqual(value);
    expect(out.refs).toHaveLength(0);
    expect(out.rejections).toHaveLength(0);
  });

  it("does not misidentify a domain object that merely carries id/mime/size", async () => {
    const { store, lookups } = makeStore({});
    // Valid 64-hex id + mime + size, but an EXTRA field ⇒ not a MediaRef wire
    // shape. It must be preserved verbatim, not stripped down to a ref.
    const value: JsonValue = {
      id: id("a"),
      mime: "image/png",
      size: 10,
      caption: "a domain row, not a ref",
    };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.value).toEqual(value);
    expect(out.refs).toHaveLength(0);
    expect(lookups()).toBe(0); // never treated as a ref → never looked up
  });

  it("ignores an object whose id is not a 64-hex digest", async () => {
    const { store } = makeStore({});
    const value: JsonValue = { id: "short", mime: "image/png", size: 1 };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.value).toEqual(value);
    expect(out.refs).toHaveLength(0);
  });

  it("finds refs nested in objects and arrays, deduping lookups by id", async () => {
    const { store, lookups } = makeStore({
      [id("a")]: owned("image/png", 100),
    });
    const ref = { id: id("a"), mime: "image/png", size: 100 };
    const value: JsonValue = {
      cover: ref,
      gallery: [ref, { nested: { again: ref } }],
    };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    // Three positions, one asset → three canonical refs, one lookup.
    expect(out.refs).toHaveLength(3);
    expect(out.rejections).toHaveLength(0);
    expect(lookups()).toBe(1);
  });
});

describe("canonicalizeMediaRefs — canonicalization", () => {
  it("strips the transient url and takes store-authoritative size (+ diagnostic)", async () => {
    const { store } = makeStore({ [id("b")]: owned("audio/wav", 2048) });
    const value: JsonValue = {
      audio: {
        id: id("b"),
        mime: "audio/wav",
        size: 999, // stale — store says 2048
        url: "https://example.com/signed.wav",
        meta: { caption: "narration" },
      },
    };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.rejections).toHaveLength(0);
    expect(out.value).toEqual({
      audio: {
        id: id("b"),
        mime: "audio/wav",
        size: 2048, // overridden
        meta: { caption: "narration" }, // position note preserved
        // url removed
      },
    });
    expect(
      out.diagnostics.some((d) => d.code === "media-size-overridden"),
    ).toBe(true);
  });

  it("keeps per-position meta.caption distinct for the same asset id", async () => {
    const { store } = makeStore({ [id("c")]: owned("image/png", 50) });
    const value: JsonValue = [
      { id: id("c"), mime: "image/png", size: 50, meta: { caption: "left" } },
      { id: id("c"), mime: "image/png", size: 50, meta: { caption: "right" } },
    ];
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.rejections).toHaveLength(0);
    const arr = out.value as Array<{ meta: { caption: string } }>;
    expect(arr[0]!.meta.caption).toBe("left");
    expect(arr[1]!.meta.caption).toBe("right");
  });
});

describe("canonicalizeMediaRefs — ownership rejection matrix", () => {
  it("rejects a ref whose asset does not exist (media-not-found)", async () => {
    const { store } = makeStore({});
    const value: JsonValue = { id: id("d"), mime: "image/png", size: 1 };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.rejections).toEqual([
      { id: id("d"), reason: "media-not-found", message: expect.any(String) },
    ]);
  });

  it("rejects a ref this session does not reference (media-ownership-invalid)", async () => {
    const { store } = makeStore({
      [id("e")]: { mime: "image/png", size: 1, refs: new Set(["other"]) },
    });
    const value: JsonValue = { id: id("e"), mime: "image/png", size: 1 };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.rejections.map((r) => r.reason)).toEqual([
      "media-ownership-invalid",
    ]);
  });

  it("rejects a ref whose declared mime disagrees with the store (media-mime-mismatch)", async () => {
    const { store } = makeStore({ [id("f")]: owned("audio/wav", 10) });
    const value: JsonValue = { id: id("f"), mime: "image/png", size: 10 };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.rejections.map((r) => r.reason)).toEqual([
      "media-mime-mismatch",
    ]);
  });

  it("collects rejections from multiple bad refs in one pass", async () => {
    const { store } = makeStore({ [id("a")]: owned("image/png", 1) });
    const value: JsonValue = {
      good: { id: id("a"), mime: "image/png", size: 1 },
      missing: { id: id("b"), mime: "image/png", size: 1 },
    };
    const out = await canonicalizeMediaRefs(value, {
      store,
      sessionId: SESSION,
    });
    expect(out.refs).toHaveLength(1);
    expect(out.rejections.map((r) => r.reason)).toEqual(["media-not-found"]);
  });
});
