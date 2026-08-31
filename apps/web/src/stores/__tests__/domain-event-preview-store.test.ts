import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearDomainEventPreviewsForTest,
  applyDomainEventPreview,
  clearDomainEventPreviews,
  clearDomainEventPreviewsForTurn,
  getDomainEventPreview,
} from "../domain-event-preview-store.js";

describe("domain event preview store", () => {
  beforeEach(() => __clearDomainEventPreviewsForTest());

  it("isolates previews by session and topic", () => {
    applyDomainEventPreview("session-a", {
      turnId: "turn-1",
      topic: "stage.direction",
      data: { cues: [{ type: "stage.clear" }] },
    });
    expect(getDomainEventPreview("session-a", "stage.direction")?.turnId).toBe(
      "turn-1",
    );
    expect(
      getDomainEventPreview("session-b", "stage.direction"),
    ).toBeUndefined();
  });

  it("clears only previews belonging to the completed turn", () => {
    applyDomainEventPreview("session-a", {
      turnId: "turn-1",
      topic: "stage.direction",
      data: {},
    });
    applyDomainEventPreview("session-a", {
      turnId: "turn-2",
      topic: "weather.preview",
      data: {},
    });
    clearDomainEventPreviewsForTurn("session-a", "turn-1");
    expect(
      getDomainEventPreview("session-a", "stage.direction"),
    ).toBeUndefined();
    expect(getDomainEventPreview("session-a", "weather.preview")).toBeDefined();
  });

  it("clears all stale previews when a new execution starts", () => {
    applyDomainEventPreview("session-a", {
      turnId: "turn-1",
      topic: "stage.direction",
      data: {},
    });
    clearDomainEventPreviews("session-a");
    expect(
      getDomainEventPreview("session-a", "stage.direction"),
    ).toBeUndefined();
  });
});
