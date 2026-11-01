import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  pluginAssetUrl,
  PLUGIN_ASSET_DIGEST_PATTERN,
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_BRIDGE_SCRIPT,
  PLUGIN_PAGE_READY_TIMEOUT_MS,
} from "../src/plugin-frame.js";
import { pluginPageDocument } from "../src/plugin-page.js";

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
  it("loads the bridge and application scripts with anonymous CORS so rejections are observable", () => {
    const html = '<head><script defer src="app.js"></script></head>';
    expect(pluginPageDocument(html, "__covel__/bridge.js")).toBe(
      '<head><script crossorigin="anonymous" src="__covel__/bridge.js"></script>' +
        '<script crossorigin="anonymous" defer src="app.js"></script></head>',
    );
  });
  it.each([
    ["<HTML><HEAD class='page'></HEAD></HTML>", "<HEAD class='page'>"],
    ["<html><body>page</body></html>", "<html>"],
    ["<!DOCTYPE html>page", "<!DOCTYPE html>"],
    ["page", ""],
  ])("injects the bridge before application code in %s", (html, opening) => {
    const bridge = '<script crossorigin="anonymous" src="bridge.js"></script>';
    expect(pluginPageDocument(html, "bridge.js")).toBe(
      opening ? html.replace(opening, opening + bridge) : bridge + html,
    );
  });
  it("normalizes script CORS attributes while preserving sources and execution order", () => {
    const scripts =
      '<SCRIPT async SRC="one.js" CROSSORIGIN=use-credentials></SCRIPT>' +
      '<script crossorigin src="two.js" defer></script>' +
      '<script src="three.js" crossorigin="anonymous"></script>';
    expect(pluginPageDocument(scripts, "../bridge.js")).toBe(
      '<script crossorigin="anonymous" src="../bridge.js"></script>' +
        '<SCRIPT async SRC="one.js" crossorigin="anonymous"></SCRIPT>' +
        '<script crossorigin="anonymous" src="two.js" defer></script>' +
        '<script src="three.js" crossorigin="anonymous"></script>',
    );
  });
  it("ignores markup in comments, raw text and inline scripts", () => {
    const before = '<!-- <head><script src="comment.js"></script> -->';
    const body =
      '<style>/* <script src="style.js"> */</style>' +
      '<textarea><script src="text.js"></script></textarea>' +
      '<noscript><script src="disabled.js"></script></noscript>' +
      "<script>const text = '<script src=\"literal.js\">';</script>";
    const html = `${before}<head><title>Page</title></head><body>${body}</body>`;
    expect(pluginPageDocument(html, "bridge.js")).toBe(
      `${before}<head><script crossorigin="anonymous" src="bridge.js"></script>` +
        `<title>Page</title></head><body>${body}</body>`,
    );
  });
  it("prepares scripts in templates without changing inert text", () => {
    const html =
      '<head></head><template><script src="later.js"></script></template>';
    expect(pluginPageDocument(html, "bridge.js")).toBe(
      '<head><script crossorigin="anonymous" src="bridge.js"></script></head>' +
        '<template><script crossorigin="anonymous" src="later.js"></script></template>',
    );
  });
  it("shares a stable bridge source with a ready or page-error acknowledgement", () => {
    expect(PLUGIN_BRIDGE_SCRIPT).toContain(
      'port.start();\n    port.postMessage({ type: failed ? "page-error" : "ready" });',
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
