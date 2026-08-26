import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRuntimeModelSlotOverride } from "../runtime-model-slot-override.js";

describe("useRuntimeModelSlotOverride", () => {
  it("tracks session props and surfaces a failed persistence", async () => {
    const onChange = vi.fn().mockRejectedValue(new Error("disk full"));
    const { result, rerender } = renderHook(
      (props: { sessionId: string; overrides: Record<string, string> }) =>
        useRuntimeModelSlotOverride({
          runtimeKey: "fixture/runtime",
          sessionId: props.sessionId,
          runtimeModelOverrides: props.overrides,
          onChange,
        }),
      {
        initialProps: {
          sessionId: "sess-a",
          overrides: { "fixture/runtime": "fast" },
        },
      },
    );

    expect(result.current[0]).toBe("fast");
    act(() => result.current[1]("quality"));
    await waitFor(() => expect(result.current[2]).toBe("disk full"));

    rerender({
      sessionId: "sess-b",
      overrides: { "fixture/runtime": "quality" },
    });
    expect(result.current[0]).toBe("quality");
    await waitFor(() => expect(result.current[2]).toBeNull());
  });
});
