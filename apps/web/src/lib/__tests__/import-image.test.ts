import { afterEach, describe, expect, it, vi } from "vitest";
import { importCssImages, importImage } from "../import-image.js";

afterEach(() => vi.unstubAllGlobals());

describe("explicit image import", () => {
  it("embeds remote backgrounds once with no credentials or referrer", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const css = await importCssImages(
      'html[data-theme="test"] { background: url("https://example.com/a.png"); --image: url(https://example.com/a.png); }',
    );
    expect(css).not.toContain("https:");
    expect(css.match(/data:image\/png;base64,AQID/g)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/a.png",
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
  });
  it("rejects unsupported protocols, non-images and oversized images", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("<svg/>", {
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(importImage("http://example.com/a.png")).rejects.toThrow(
      "HTTPS",
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(importImage("https://example.com/a.svg")).rejects.toThrow(
      "raster",
    );
    fetcher.mockImplementation(
      async () =>
        new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
          headers: { "content-type": "image/png" },
        }),
    );
    await expect(importImage("https://example.com/a.png")).rejects.toThrow(
      "5 MiB",
    );
  });
  it("preserves local images and gradients without a network request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const css =
      "background: url(data:image/png;base64,AQID), linear-gradient(red, blue)";
    expect(await importCssImages(css)).toBe(css);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
