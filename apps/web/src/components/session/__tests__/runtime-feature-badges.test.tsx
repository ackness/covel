import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameworkCapability } from "@covel/shared";
import i18n from "@/i18n";
import {
  deriveRuntimeFeatures,
  RuntimeCollectionFeatureBadges,
  RuntimeFeatureBadges,
} from "../runtime-feature-badges.js";

describe("runtime feature badges", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => cleanup());

  it("derives background function, trigger, and media from runtime metadata", () => {
    expect(
      deriveRuntimeFeatures({
        kind: "function",
        trigger: { type: "manual" },
        capabilities: ["tts"],
        execution: "background",
      }).map((feature) => feature.kind),
    ).toEqual(["background", "function", "manual", "media"]);
  });

  it("derives staged detached AI narrative features", () => {
    expect(
      deriveRuntimeFeatures({
        runtimeType: "agent",
        trigger: { type: "auto" },
        capabilities: [FrameworkCapability.Narrative],
        turnCompletion: { mode: "detached" },
      }).map((feature) => feature.kind),
    ).toEqual(["background", "agent", "automatic", "narrative"]);
  });

  it("does not invent a trigger or output category for unknown metadata", () => {
    expect(
      deriveRuntimeFeatures({
        kind: "function",
        trigger: { type: "custom" },
      }).map((feature) => feature.kind),
    ).toEqual(["function"]);
  });

  it("renders compact labels with descriptive accessible names", () => {
    render(
      <RuntimeFeatureBadges
        runtime={{
          kind: "function",
          trigger: { type: "event" },
          outputKind: "system",
          execution: "background",
        }}
      />,
    );

    expect(screen.getByText("Background")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Runs in the background without blocking the foreground flow",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Runs as a local function")).toBeTruthy();
    expect(
      screen.getByLabelText("Runs in response to a declared event"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Produces system-level output")).toBeTruthy();
  });

  it("deduplicates aggregate markers across package runtimes", () => {
    render(
      <RuntimeCollectionFeatureBadges
        runtimes={[
          {
            kind: "agent",
            trigger: { type: "auto" },
            outputKind: "story",
          },
          {
            kind: "agent",
            trigger: { type: "auto" },
            outputKind: "story",
          },
        ]}
      />,
    );

    expect(screen.getAllByText("AI")).toHaveLength(1);
    expect(screen.getAllByText("Automatic")).toHaveLength(1);
    expect(screen.getAllByText("Narrative")).toHaveLength(1);
  });
});
