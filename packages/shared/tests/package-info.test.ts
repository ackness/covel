import { describe, expect, it } from "vitest";
import {
  collectionManifestSchema,
  packageAuthorSchema,
  packageInfoOf,
  pluginManifestSchema,
  worldManifestSchema,
} from "../src/index.js";

const author = {
  name: "Jane Doe",
  url: "https://example.com",
  about: "I write small mystery worlds.",
  links: [{ label: "Community", url: "https://example.com/community" }],
};

describe("package credits", () => {
  it("is the same block in a plugin, a world and a collection", () => {
    const credits = { author, license: "MIT", homepage: "https://example.com" };
    expect(
      pluginManifestSchema.parse({
        id: "demo",
        kind: "plugin",
        description: "A demo plugin.",
        ...credits,
      }),
    ).toMatchObject(credits);
    expect(
      worldManifestSchema.parse({
        schemaVersion: "1.0",
        id: "demo",
        name: "Demo",
        summary: "A demo world.",
        defaultLocale: "en-US",
        ...credits,
      }),
    ).toMatchObject(credits);
    expect(
      collectionManifestSchema.parse({
        schemaVersion: 1,
        id: "demo-pack",
        name: "Demo Pack",
        worlds: [{ path: "worlds/demo" }],
        ...credits,
      }),
    ).toMatchObject(credits);
  });

  it("takes a translated message and link label, as a compiled locale file gives them", () => {
    expect(
      packageAuthorSchema.safeParse({
        name: "Jane Doe",
        about: { en: "Hello.", zh: "你好。" },
        links: [
          {
            label: { en: "Community", zh: "社区" },
            url: "https://example.com/community",
          },
        ],
      }).success,
    ).toBe(true);
  });

  // The host opens a link in the player's browser, so only a plain https
  // address may reach that step.
  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "https://example.com/a b",
    "example.com",
  ])("rejects the link %s", (url) => {
    expect(
      packageAuthorSchema.safeParse({ name: "Jane Doe", url }).success,
    ).toBe(false);
    expect(
      packageAuthorSchema.safeParse({
        name: "Jane Doe",
        links: [{ label: "Site", url }],
      }).success,
    ).toBe(false);
  });

  it("limits the links and the length of the message", () => {
    const link = { label: "Site", url: "https://example.com" };
    expect(
      packageAuthorSchema.safeParse({
        name: "Jane Doe",
        links: Array.from({ length: 7 }, () => link),
      }).success,
    ).toBe(false);
    expect(
      packageAuthorSchema.safeParse({
        name: "Jane Doe",
        about: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("gives a manifest's version and credits, or nothing when it has none", () => {
    expect(packageInfoOf({ id: "demo", version: "1.2.0", author })).toEqual({
      version: "1.2.0",
      author,
    });
    expect(packageInfoOf({ id: "demo", name: "Demo" })).toBeUndefined();
  });
});
