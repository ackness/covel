import { describe, it, expect } from "vitest";
import { resolveBlockSubmission } from "../block-submission-utils.js";

describe("resolveBlockSubmission", () => {
  it("routes core image settings updates to a trigger event", () => {
    const result = resolveBlockSubmission(
      "core_image_settings",
      JSON.stringify({
        type: "core_image_settings.update",
        settings: { style: "anime", multiPanel: true },
      }),
    );

    expect(result).toEqual({
      kind: "trigger_event",
      eventType: "image.settings.updated",
      eventData: {
        settings: { style: "anime", multiPanel: true },
      },
    });
  });

  it("falls back to a normal chat message for invalid settings payloads", () => {
    const result = resolveBlockSubmission("core_image_settings", "not-json");
    expect(result).toEqual({ kind: "message", content: "not-json" });
  });

  it("leaves other block types as normal chat messages", () => {
    const result = resolveBlockSubmission("choice_set", "attack");
    expect(result).toEqual({ kind: "message", content: "attack" });
  });
});
