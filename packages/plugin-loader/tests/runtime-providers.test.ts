import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { resolveRuntimeProviders } from "../src/runtime-providers.js";

const creation = {
  name: "core/create",
  pluginId: "core",
  capabilities: ["creation"],
  fallbackFor: "creation",
} as RuntimeManifest;
const tracker = { name: "core/track", pluginId: "core" } as RuntimeManifest;
const provider = {
  name: "external/create",
  pluginId: "external",
  capabilities: ["creation"],
} as RuntimeManifest;

describe("runtime capability defaults", () => {
  it("keeps the default until an alternative is active, preserving sibling runtimes", () => {
    expect(resolveRuntimeProviders([creation, tracker])).toEqual([
      creation,
      tracker,
    ]);
    expect(resolveRuntimeProviders([creation, tracker, provider])).toEqual([
      tracker,
      provider,
    ]);
    expect(resolveRuntimeProviders([provider, creation, tracker])).toEqual([
      provider,
      tracker,
    ]);
    expect(resolveRuntimeProviders([creation, tracker])).toEqual([
      creation,
      tracker,
    ]);
  });
  it("rejects competing providers instead of silently picking one", () => {
    expect(() =>
      resolveRuntimeProviders([
        creation,
        provider,
        { ...provider, name: "another/create" },
      ]),
    ).toThrow("Multiple active providers");
  });
});
