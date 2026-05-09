import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ModelCapabilityInfo } from "@/services/api.js";
import {
  CapabilityEditor,
  CapabilityTags,
  formatPrice,
  formatTokenCount,
} from "../llm-capability-controls.js";

describe("llm capability controls", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("formats token counts and pricing consistently", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(1_500)).toBe("1.5K");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");

    expect(formatPrice(0.004)).toBe("$0.004/M");
    expect(formatPrice(0.25)).toBe("$0.25/M");
    expect(formatPrice(2)).toBe("$2.0/M");
  });

  it("renders non-default capability tags, limits, and pricing", () => {
    render(
      <CapabilityTags
        capability={{
          input: ["text", "image", "audio"],
          output: ["text", "embedding"],
          features: ["streaming", "function_calling", "web_search"],
          contextWindow: 1_500_000,
          maxOutputTokens: 8_000,
          pricing: { inputPerMToken: 0.2, outputPerMToken: 1.5 },
        }}
      />,
    );

    expect(screen.queryByText("Text Input")).toBeNull();
    expect(screen.queryByText("Text Output")).toBeNull();
    expect(screen.queryByText("Streaming")).toBeNull();
    expect(screen.getByText("Image Input")).toBeTruthy();
    expect(screen.getByText("Audio Input")).toBeTruthy();
    expect(screen.getByText("Embedding")).toBeTruthy();
    expect(screen.getByText("Function Calling")).toBeTruthy();
    expect(screen.getByText("Web Search")).toBeTruthy();
    expect(screen.getByText("ctx: 1.5M")).toBeTruthy();
    expect(screen.getByText("out: 8K")).toBeTruthy();
    expect(screen.getByText("$0.20/M / $1.5/M")).toBeTruthy();
  });

  it("renders per-image pricing without token pricing", () => {
    render(
      <CapabilityTags
        capability={{
          input: ["text"],
          output: ["image"],
          pricing: { perImage: 0.04 },
        }}
      />,
    );

    expect(screen.getByText("Image Generation")).toBeTruthy();
    expect(screen.getByText("$0.04/img")).toBeTruthy();
  });

  it("emits override patches from modality and feature toggles", () => {
    const onUpdate = vi.fn();
    const serverCap: ModelCapabilityInfo = {
      input: ["text", "image"],
      output: ["text"],
      features: ["streaming"],
    };

    render(
      <CapabilityEditor
        serverCap={serverCap}
        override={undefined}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Image Input" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ input: ["text"] });

    fireEvent.click(screen.getByRole("button", { name: "Audio Input" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      input: ["text", "image", "audio"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Embedding" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      output: ["text", "embedding"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Streaming" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ features: [] });

    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      features: ["streaming", "reasoning"],
    });
  });

  it("emits numeric and pricing patches from editor inputs", () => {
    const onUpdate = vi.fn();

    render(
      <CapabilityEditor
        serverCap={{
          input: ["text"],
          output: ["text"],
          pricing: { inputPerMToken: 0.3, outputPerMToken: 0.6 },
        }}
        override={{ pricing: { outputPerMToken: 1.2 } }}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. 131072"), {
      target: { value: "64000" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ contextWindow: 64000 });

    fireEvent.change(screen.getByPlaceholderText("e.g. 8192"), {
      target: { value: "4096" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ maxOutputTokens: 4096 });

    fireEvent.change(screen.getByPlaceholderText("0.3"), {
      target: { value: "0.9" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      pricing: { outputPerMToken: 1.2, inputPerMToken: 0.9 },
    });

    fireEvent.change(screen.getByDisplayValue("1.2"), {
      target: { value: "" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      pricing: { outputPerMToken: undefined },
    });
  });
});
