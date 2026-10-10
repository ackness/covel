// @vitest-environment node
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
