import { describe, expect, it } from "vitest";
import {
  autoAssignRuntimeBindings,
  filterRuntimeBindingsForKnownRuntimes,
  sanitizeRuntimeBindingsForHeader,
} from "../../web/src/lib/runtime-binding-utils.js";

describe("runtime-binding-utils", () => {
  it("filters out bindings for unknown runtimes while preserving explicit empty selections", () => {
    const result = filterRuntimeBindingsForKnownRuntimes(
      {
        "plugin-a:story": "story",
        "plugin-b:image": "",
        "plugin-c:stale": "utility",
      },
      ["plugin-a:story", "plugin-b:image"],
    );

    expect(result).toEqual({
      "plugin-a:story": "story",
      "plugin-b:image": "",
    });
  });

  it("drops empty runtime bindings before building request headers", () => {
    const result = sanitizeRuntimeBindingsForHeader({
      "plugin-a:story": "story",
      "plugin-b:image": "",
    });

    expect(result).toEqual({
      "plugin-a:story": "story",
    });
  });

  it("auto-assigns first compatible slots without overwriting existing non-empty bindings", () => {
    const result = autoAssignRuntimeBindings(
      {
        "plugin-a:story": "manual-story",
        "plugin-b:image": "",
      },
      [
        { qualifiedId: "plugin-a:story", providerTag: "text" },
        { qualifiedId: "plugin-b:image", providerTag: "image" },
        { qualifiedId: "plugin-c:helper", providerTag: "text" },
      ],
      [
        { slotId: "story", tag: "text" },
        { slotId: "image", tag: "image" },
      ],
    );

    expect(result).toEqual({
      "plugin-a:story": "manual-story",
      "plugin-b:image": "image",
      "plugin-c:helper": "story",
    });
  });
});
