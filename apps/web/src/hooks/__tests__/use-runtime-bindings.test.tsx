import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@/services/api.js";
import type { ResolvedSlot } from "../use-slot-config.js";
import { useRuntimeBindings } from "../use-runtime-bindings.js";

const packages: PluginSummary[] = [
  {
    id: "fixture-package",
    displayName: "Fixture package",
    description: "Fixture package",
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 1,
    capabilities: [],
    tags: [],
    runtimes: [
      {
        id: "fixture-package/runtime",
        runtimeType: "agent",
        model: "text",
        trigger: { type: "auto" },
        execution: "sync",
        turnCompletion: { mode: "await" },
        outputKind: "plugin",
        capabilities: [],
        tags: [],
      },
    ],
    tools: [],
    userSettings: [],
  },
];

const slots: ResolvedSlot[] = [
  {
    slotId: "text",
    presetId: "",
    preset: null,
    label: "text",
    tag: "text",
  },
  {
    slotId: "custom",
    presetId: "",
    preset: null,
    label: "custom",
    tag: "text",
  },
];
const savedBindings = { "fixture-package/runtime": "custom" };

describe("useRuntimeBindings hydration", () => {
  it("does not overwrite saved bindings with auto-assigned defaults on mount", async () => {
    const onPersist = vi.fn();
    const { result } = renderHook(() =>
      useRuntimeBindings(
        "prep:world-1",
        packages,
        slots,
        undefined,
        savedBindings,
        onPersist,
      ),
    );

    await waitFor(() =>
      expect(result.current.bindings).toEqual({
        "fixture-package/runtime": "custom",
      }),
    );
    expect(onPersist).not.toHaveBeenCalled();
  });
});
