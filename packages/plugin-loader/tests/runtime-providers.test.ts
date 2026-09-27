import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { resolveRuntimeProviders } from "../src/runtime-providers.js";

const creation = {
  name: "core/create",
  pluginId: "core",
  outputContract: "creation@1",
  defaultProvider: true,
} as RuntimeManifest;
const tracker = { name: "core/track", pluginId: "core" } as RuntimeManifest;
const provider = {
  name: "external/create",
  pluginId: "external",
  outputContract: "creation@1",
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
  it("keeps ordinary multiple providers for cardinality-all consumers", () => {
    const another = {
      ...provider,
      name: "another/create",
      pluginId: "another",
    };
    expect(resolveRuntimeProviders([creation, provider, another])).toEqual([
      provider,
      another,
    ]);
  });
  it("keeps multiple defaults until the package resolver selects or replaces them", () => {
    const other = { ...creation, name: "other/create", pluginId: "other" };
    expect(resolveRuntimeProviders([creation, other])).toEqual([
      creation,
      other,
    ]);
    expect(resolveRuntimeProviders([creation, other, provider])).toEqual([
      provider,
    ]);
  });
});
