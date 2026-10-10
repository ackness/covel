// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  allowHost,
  classifyImageSrc,
  isHostAllowed,
} from "../external-images.js";

const ORIGIN = "http://127.0.0.1:3001";

describe("classifyImageSrc", () => {
  it.each([
    "/api/sessions/s1/media/m1",
    "media/map.png",
    "http://127.0.0.1:3001/x.png",
    "data:image/png;base64,AAAA",
    "blob:http://127.0.0.1:3001/1234",
  ])("loads %s without asking", (src) => {
    expect(classifyImageSrc(src, ORIGIN)).toEqual({ kind: "local" });
  });

  it("names the host of an image on another origin", () => {
    expect(
      classifyImageSrc("https://Evil.example:8443/p.png?q=secret", ORIGIN),
    ).toEqual({ kind: "external", host: "evil.example:8443" });
  });

  it("treats a protocol-relative URL as external", () => {
    expect(classifyImageSrc("//cdn.example/a.png", ORIGIN)).toEqual({
      kind: "external",
      host: "cdn.example",
    });
  });

  it("treats another port on the same host as another origin", () => {
    expect(classifyImageSrc("http://127.0.0.1:9999/a.png", ORIGIN).kind).toBe(
      "external",
    );
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://h/a.png", ""])(
    "blocks %j",
    (src) => {
      expect(classifyImageSrc(src, ORIGIN)).toEqual({ kind: "blocked" });
    },
  );
});

describe("allowed hosts", () => {
  it("remembers a host per world only", () => {
    const next = allowHost({}, "w1", "cdn.example");
    expect(isHostAllowed(next, "w1", "cdn.example")).toBe(true);
    expect(isHostAllowed(next, "w2", "cdn.example")).toBe(false);
    expect(isHostAllowed(next, undefined, "cdn.example")).toBe(false);
  });

  it("does not duplicate a host", () => {
    const once = allowHost({}, "w1", "cdn.example");
    expect(allowHost(once, "w1", "cdn.example")).toBe(once);
  });
});
