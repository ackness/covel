import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  pluginAssetUrl,
  PLUGIN_ASSET_DIGEST_PATTERN,
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_BRIDGE_SCRIPT,
  PLUGIN_PAGE_READY_TIMEOUT_MS,
} from "../src/plugin-frame.js";

describe("plugin pages", () => {
  it("encodes every URL segment", () => {
    expect(pluginAssetUrl("a b", "d?", "pages/a #.html")).toBe(
      "/plugin-assets/a%20b/d%3F/pages/a%20%23.html",
    );
    expect(PLUGIN_ASSET_DIGEST_PATTERN.test("a".repeat(32))).toBe(true);
    expect(PLUGIN_ASSET_DIGEST_PATTERN.test("A".repeat(32))).toBe(false);
    expect(PLUGIN_PAGE_READY_TIMEOUT_MS).toBe(8000);
  });
  it("has the complete page containment policy", () => {
    expect(new Set(PLUGIN_ASSET_PAGE_CSP.split("; "))).toEqual(
      new Set([
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "sandbox allow-scripts",
        "frame-ancestors 'self'",
      ]),
    );
    expect(PLUGIN_ASSET_PAGE_CSP).not.toContain("unsafe-eval");
  });
  it("shares a stable bridge source with a ready acknowledgement", () => {
    expect(PLUGIN_BRIDGE_SCRIPT).toContain(
      'port.start();\n    port.postMessage({ type: "ready" });',
    );
    const hash8 = createHash("sha256")
      .update(PLUGIN_BRIDGE_SCRIPT)
      .digest("hex")
      .slice(0, 8);
    expect(`bridge-${hash8}.js`).toMatch(/^bridge-[a-f0-9]{8}\.js$/);
    expect(
      createHash("sha256")
        .update(PLUGIN_BRIDGE_SCRIPT)
        .digest("hex")
        .startsWith(hash8),
    ).toBe(true);
  });
});
