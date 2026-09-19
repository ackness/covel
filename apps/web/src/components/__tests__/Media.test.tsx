/**
 * Behavioural tests for `<Media>`.
 *
 * Covers:
 *   - MediaRef → image / audio / video routing by mime
 *   - sentinel placeholder when resolution fails
 *   - blob URL revoked on unmount
 *
 * Network responses are deterministic; fake-indexeddb covers transaction
 * ordering with native structured-cloneable Blobs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { Blob as NativeBlob } from "node:buffer";

let Media: typeof import("../Media.js").Media;
let connections: IDBDatabase[];
import { sha256Hex } from "../../lib/media-hash.js";
import type { MediaRef } from "@covel/shared";

const PAYLOAD_BYTES = new TextEncoder().encode("payload");
async function makeRef(mime: string): Promise<MediaRef> {
  const buffer = PAYLOAD_BYTES.buffer.slice(
    PAYLOAD_BYTES.byteOffset,
    PAYLOAD_BYTES.byteOffset + PAYLOAD_BYTES.byteLength,
  ) as ArrayBuffer;
  const id = await sha256Hex(buffer);
  return { id, mime, size: PAYLOAD_BYTES.byteLength };
}

const realFetch = globalThis.fetch;
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

let revokeSpy: ReturnType<typeof vi.fn>;
let urlCounter = 0;

beforeEach(async () => {
  vi.resetModules();
  const factory = new FakeIDBFactory();
  connections = [];
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("Blob", NativeBlob);
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((name, version) => {
    const request = open(name, version);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  ({ Media } = await import("../Media.js"));
  urlCounter = 0;
  globalThis.URL.createObjectURL = vi.fn(
    () => "blob:test/" + ++urlCounter,
  ) as unknown as typeof URL.createObjectURL;
  revokeSpy = vi.fn();
  globalThis.URL.revokeObjectURL =
    revokeSpy as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  for (const connection of connections) connection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
});

function setFetchToBlob(mime: string): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.startsWith("/api/sessions/")) {
      return new Response(
        JSON.stringify({ url: "https://signed.example/media?token=ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // jsdom's `Response(Blob)` stringifies to "[object Blob]" — feed the
    // raw bytes directly so the body length matches the ref.size promised.
    return new Response(new Uint8Array(PAYLOAD_BYTES), {
      status: 200,
      headers: { "Content-Type": mime },
    });
  }) as unknown as typeof globalThis.fetch;
}

function setFetchAlwaysFails(): void {
  globalThis.fetch = vi.fn(
    async () => new Response("nope", { status: 500 }),
  ) as unknown as typeof globalThis.fetch;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("<Media>", () => {
  it("renders <img> for MediaRef with image mime", async () => {
    const ref: MediaRef = {
      ...(await makeRef("image/png")),
      url: "https://cdn.example/a.png",
    };
    setFetchToBlob("image/png");
    render(<Media src={ref} sessionId="s1" alt="picture" />);
    await waitFor(() => {
      const img = screen.getByAltText("picture") as HTMLImageElement;
      expect(img.tagName).toBe("IMG");
      expect(img.src.startsWith("blob:")).toBe(true);
    });
  });

  it("renders <audio> for MediaRef with audio mime", async () => {
    const ref: MediaRef = {
      ...(await makeRef("audio/mp3")),
      url: "https://cdn.example/a.mp3",
    };
    setFetchToBlob("audio/mp3");
    const { container } = render(<Media src={ref} sessionId="s1" alt="song" />);
    await waitFor(() => {
      const audio = container.querySelector("audio");
      expect(audio).not.toBeNull();
      expect(audio?.getAttribute("src")?.startsWith("blob:")).toBe(true);
      expect(audio?.hasAttribute("controls")).toBe(true);
    });
  });

  it("renders <video> for MediaRef with video mime", async () => {
    const ref: MediaRef = {
      ...(await makeRef("video/mp4")),
      url: "https://cdn.example/a.mp4",
    };
    setFetchToBlob("video/mp4");
    const { container } = render(<Media src={ref} sessionId="s1" alt="clip" />);
    await waitFor(() => {
      const video = container.querySelector("video");
      expect(video).not.toBeNull();
      expect(video?.getAttribute("src")?.startsWith("blob:")).toBe(true);
      expect(video?.hasAttribute("controls")).toBe(true);
    });
  });

  it("renders unavailable state when resolution fails", async () => {
    const ref: MediaRef = {
      ...(await makeRef("image/png")),
      url: "https://broken.example/missing.png",
    };
    setFetchAlwaysFails();
    render(<Media src={ref} sessionId="s1" alt="oops" />);
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "oops" })).toBeTruthy();
      expect(screen.queryByAltText("oops")).toBeNull();
    });
  });

  it("revokes blob URL on unmount", async () => {
    const ref: MediaRef = {
      ...(await makeRef("image/png")),
      url: "https://cdn.example/r.png",
    };
    setFetchToBlob("image/png");
    const { unmount } = render(<Media src={ref} sessionId="s1" alt="temp" />);
    await waitFor(() => {
      const img = screen.getByAltText("temp") as HTMLImageElement;
      expect(img.src.startsWith("blob:")).toBe(true);
    });
    unmount();
    expect(revokeSpy).toHaveBeenCalled();
  });

  it("respects `as` override for image-mime payloads", async () => {
    const ref: MediaRef = {
      ...(await makeRef("application/octet-stream")),
      url: "https://cdn.example/blob.bin",
    };
    setFetchToBlob("application/octet-stream");
    const { container } = render(
      <Media src={ref} sessionId="s1" alt="forced-audio" as="audio" />,
    );
    await waitFor(() => {
      expect(container.querySelector("audio")).not.toBeNull();
    });
  });
});
