import React, { createElement, type ComponentType } from "react";

import { AudioClipBlock } from "./components/blocks/audio-clip.js";
import { ChoiceSetBlock } from "./components/blocks/choice-set.js";
import { DiceResultBlock } from "./components/blocks/dice-result.js";
import { ImageCardBlock } from "./components/blocks/image-card.js";
import { SchemaFallbackBlock } from "./components/blocks/schema-fallback.js";
import type { HostBlockRendererProps } from "./components/blocks/types.js";

const REGISTRY: Record<string, ComponentType<HostBlockRendererProps>> = {
  choices: ChoiceSetBlock,
  choice_set: ChoiceSetBlock,
  dice_result: DiceResultBlock,
  image_card: ImageCardBlock,
  audio_clip: AudioClipBlock
};

export function resolveBlockRenderer(type: string): ComponentType<HostBlockRendererProps> {
  return REGISTRY[type] ?? SchemaFallbackBlock;
}

export function BlockRenderer(props: HostBlockRendererProps) {
  const Renderer = resolveBlockRenderer(props.block.type);
  return createElement(Renderer, props);
}
