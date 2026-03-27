// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlockEnvelope } from "../../../modules/contracts/src/index.js";
import { createInteractiveBlock } from "./helpers/fixtures.js";
import { loadWebModule } from "./helpers/load-web-module.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

interface BlockRendererProps {
  block: BlockEnvelope;
  onChoiceSelect?(optionId: string): void;
}

interface BlockRendererRegistryModule {
  BlockRenderer: ComponentType<BlockRendererProps>;
  resolveBlockRenderer(type: string): ComponentType<BlockRendererProps>;
}

afterEach(() => {
  cleanup();
});

describe("apps/web block renderer registry", () => {
  it("resolves dedicated renderers for known block types", async () => {
    const registry = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );

    expect(registry.resolveBlockRenderer("choices")).toBeTypeOf("function");
    expect(registry.resolveBlockRenderer("choice_set")).toBeTypeOf("function");
    expect(registry.resolveBlockRenderer("dice_result")).toBeTypeOf("function");
    expect(registry.resolveBlockRenderer("image_card")).toBeTypeOf("function");
    expect(registry.resolveBlockRenderer("audio_clip")).toBeTypeOf("function");
    expect(registry.resolveBlockRenderer("unknown_block")).toBeTypeOf("function");
  });

  it("renders choice-based blocks and forwards option selection", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );
    const onChoiceSelect = vi.fn();
    const user = userEvent.setup();

    renderWithI18n(createElement(BlockRenderer, {
      block: createInteractiveBlock({
        type: "choice_set"
      }),
      onChoiceSelect
    }));

    expect(screen.getByText("下一步做什么？")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "继续前进" }));

    expect(onChoiceSelect).toHaveBeenCalledWith("opt_a");
  });

  it("loads a package-owned renderer for non-interactive package blocks", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );
    const view = renderWithI18n(createElement(BlockRenderer, {
      block: createInteractiveBlock({
        interaction: {
          requiresResponse: false
        }
      })
    }));

    await waitFor(() => {
      expect(view.container.querySelector('[data-package-renderer="core-guide/choices"]')).toBeTruthy();
    });
  });

  it("renders dice result blocks as structured data rather than raw JSON only", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );

    renderWithI18n(createElement(BlockRenderer, {
      block: createBlock({
        type: "dice_result",
        interaction: {
          requiresResponse: false
        },
        data: {
          title: "判定结果",
          formula: "2d6+3",
          total: 11,
          outcome: "success"
        }
      })
    }));

    expect(screen.getByText("判定结果")).toBeTruthy();
    expect(screen.getByText("2d6+3")).toBeTruthy();
    expect(screen.getByText("11")).toBeTruthy();
    expect(screen.getByText("success")).toBeTruthy();
  });

  it("renders image card blocks with an image element", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );

    renderWithI18n(createElement(BlockRenderer, {
      block: createBlock({
        type: "image_card",
        interaction: {
          requiresResponse: false
        },
        data: {
          title: "雾港码头",
          imageUrl: "https://example.invalid/harbor.png",
          alt: "雾港码头"
        }
      })
    }));

    expect(screen.getByText("雾港码头")).toBeTruthy();
    expect(screen.getByRole("img", { name: "雾港码头" })).toBeTruthy();
  });

  it("renders audio clip blocks with an audio player", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );

    const view = renderWithI18n(createElement(BlockRenderer, {
      block: createBlock({
        type: "audio_clip",
        interaction: {
          requiresResponse: false
        },
        data: {
          title: "旁白语音",
          audioUrl: "https://example.invalid/narration.mp3"
        }
      })
    }));

    expect(screen.getByText("旁白语音")).toBeTruthy();
    expect(view.container.querySelector("audio")).toBeTruthy();
  });

  it("falls back to a generic renderer for unknown block types", async () => {
    const { BlockRenderer } = await loadWebModule<BlockRendererRegistryModule>(
      "block-renderer-registry.tsx"
    );

    renderWithI18n(createElement(BlockRenderer, {
      block: createBlock({
        type: "mystery_block",
        interaction: {
          requiresResponse: false
        },
        data: {
          title: "Unknown payload",
          value: "shadow-signal"
        }
      })
    }));

    expect(screen.getByText("mystery_block")).toBeTruthy();
    expect(screen.getByText(/shadow-signal/)).toBeTruthy();
  });
});

function createBlock(overrides: Partial<BlockEnvelope>): BlockEnvelope {
  return {
    ...createInteractiveBlock(),
    ...overrides
  };
}
