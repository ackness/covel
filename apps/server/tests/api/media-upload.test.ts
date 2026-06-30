/**
 * Integration tests for `POST /api/media` (player image upload).
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryMediaStore, type MediaStore } from "@covel/store";
import { mediaRoutes } from "../../src/routes/api/media.js";

// A few non-empty bytes — content is irrelevant, the store content-addresses.
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function makeApp(withStore = true): { app: Hono; mediaStore?: MediaStore } {
  const app = new Hono();
  let mediaStore: MediaStore | undefined;
  if (withStore) {
    mediaStore = createMemoryMediaStore();
    app.use("*", async (c, next) => {
      c.set("mediaStore", mediaStore);
      await next();
    });
  }
  app.route("/api/media", mediaRoutes);
  return { app, mediaStore };
}

describe("POST /api/media (upload)", () => {
  it("stores an image and returns a content-addressed ref the session can read", async () => {
    const { app, mediaStore } = makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(200);
    const ref = (await res.json()) as {
      id: string;
      mime: string;
      size: number;
    };
    expect(ref.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.mime).toBe("image/png");
    expect(ref.size).toBe(IMG.byteLength);
    expect(await mediaStore!.isReferencedBy(ref.id, "s1")).toBe(true);
  });

  it("rejects a missing sessionId", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/media", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-image content type", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: IMG,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no media store is configured", async () => {
    const { app } = makeApp(false);
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(503);
  });
});
