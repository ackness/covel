// @vitest-environment node
import { readFileSync } from "node:fs";
import { PLUGIN_FRAME_CSP, PLUGIN_FRAME_RESPONSE_CSP } from "@covel/shared";
import { describe, expect, it } from "vitest";
import { PAGE_CSP, injectPageCsp } from "../page-csp.js";

describe("injectPageCsp", () => {
  it("puts the policy before anything else in the head", () => {
    const html = injectPageCsp(
      '<html><head><meta charset="UTF-8" /><script src="/a.js"></script></head></html>',
    );
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("charset"),
    );
  });

  it("blocks eval and plugins and leaves images to the Markdown gate", () => {
    expect(PAGE_CSP).not.toContain("unsafe-eval");
    expect(PAGE_CSP).toContain("object-src 'none'");
    expect(PAGE_CSP).not.toContain("img-src");
  });
});

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([head]) => head === name);
  return found ? found.slice(1) : [];
}

describe("PAGE_CSP", () => {
  it("runs only the app's own script files", () => {
    expect(directive(PAGE_CSP, "script-src")).toEqual(["'self'"]);
    expect(PAGE_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // Nothing else may decide script loading in place of `script-src`.
    expect(PAGE_CSP).not.toMatch(/script-src-(elem|attr)/);
  });

  it("frames only documents of the app's own origin", () => {
    expect(directive(PAGE_CSP, "frame-src")).toEqual(["'self'"]);
  });
});

describe("the source page", () => {
  it("has no inline script and no inline event handler", () => {
    const html = readFileSync(
      new URL("../../../index.html", import.meta.url),
      "utf8",
    );
    const scripts = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toContain("src=");
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe("the plugin frame host", () => {
  const html = readFileSync(
    new URL("../../../public/plugin-frame.html", import.meta.url),
    "utf8",
  );

  it("carries the plugin frame policy before any script", () => {
    const meta =
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(
        html,
      );
    expect(meta?.[1]).toBe(PLUGIN_FRAME_CSP);
    expect(meta?.index).toBeLessThan(html.indexOf("<script"));
  });

  it("allows no network load and no navigation of the plugin document", () => {
    expect(directive(PLUGIN_FRAME_CSP, "default-src")).toEqual(["'none'"]);
    expect(directive(PLUGIN_FRAME_CSP, "connect-src")).toEqual(["'none'"]);
    expect(directive(PLUGIN_FRAME_CSP, "frame-src")).toEqual(["'none'"]);
    expect(PLUGIN_FRAME_RESPONSE_CSP).toContain("sandbox allow-scripts");
    expect(PLUGIN_FRAME_RESPONSE_CSP).not.toContain("allow-same-origin");
  });
});
