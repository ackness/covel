import React, { createElement, type ComponentType, useEffect, useState } from "react";

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

interface PackageManifestLike {
  name: string;
  contributes?: {
    blocks?: Array<{
      type: string;
      ui?: {
        component?: string;
        renderer?: string;
      };
    }>;
    blockTypes?: Array<{
      type: string;
      ui?: {
        component?: string;
        renderer?: string;
      };
    }>;
    renderers?: Array<{
      name: string;
      entry: string;
    }>;
  };
}

const PACKAGE_MANIFESTS = import.meta.glob("../../../extensions/*/manifest.json", {
  eager: true,
  import: "default"
}) as Record<string, PackageManifestLike>;

const PACKAGE_RENDERER_MODULES = import.meta.glob("../../../extensions/*/client/renderers/*.tsx") as Record<
  string,
  () => Promise<{ default?: ComponentType<any> }>
>;

const PACKAGE_RENDERER_LOADERS = new Map<string, () => Promise<{ default?: ComponentType<any> }>>();
const PACKAGE_RENDERER_CACHE = new Map<string, ComponentType<any>>();

for (const manifest of Object.values(PACKAGE_MANIFESTS)) {
  const renderers = new Map(
    (manifest.contributes?.renderers ?? []).map((renderer) => [renderer.name, renderer.entry] as const)
  );
  const blocks = manifest.contributes?.blockTypes ?? manifest.contributes?.blocks ?? [];

  for (const block of blocks) {
    const rendererName = block.ui?.renderer;
    const rendererEntry = rendererName ? renderers.get(rendererName) : undefined;
    if (!rendererEntry) {
      continue;
    }

    const loader = PACKAGE_RENDERER_MODULES[`../../../extensions/${manifest.name}/${rendererEntry}`];
    if (!loader) {
      continue;
    }

    PACKAGE_RENDERER_LOADERS.set(`${manifest.name}:${block.type}`, loader);
  }
}

export function resolveBlockRenderer(type: string): ComponentType<HostBlockRendererProps> {
  return REGISTRY[type] ?? SchemaFallbackBlock;
}

export function BlockRenderer(props: HostBlockRendererProps) {
  const packageRendererKey = `${props.block.meta.package}:${props.block.type}`;
  const packageRendererLoader = PACKAGE_RENDERER_LOADERS.get(packageRendererKey);
  const hostRenderer = resolveBlockRenderer(props.block.type);
  const shouldPreferHostRenderer = props.block.interaction.requiresResponse && hostRenderer !== SchemaFallbackBlock;
  const [PackageRenderer, setPackageRenderer] = useState<ComponentType<any> | null>(() =>
    PACKAGE_RENDERER_CACHE.get(packageRendererKey) ?? null
  );

  useEffect(() => {
    if (!packageRendererLoader) {
      setPackageRenderer(null);
      return;
    }

    const cachedRenderer = PACKAGE_RENDERER_CACHE.get(packageRendererKey);
    if (cachedRenderer) {
      setPackageRenderer(() => cachedRenderer);
      return;
    }

    let active = true;
    void packageRendererLoader().then((module) => {
      const nextRenderer = module.default;
      if (!active || !nextRenderer) {
        return;
      }
      PACKAGE_RENDERER_CACHE.set(packageRendererKey, nextRenderer);
      setPackageRenderer(() => nextRenderer);
    });

    return () => {
      active = false;
    };
  }, [packageRendererKey, packageRendererLoader]);

  if (PackageRenderer && !shouldPreferHostRenderer) {
    return createElement(PackageRenderer, {
      ...props,
      data: props.block.data
    });
  }

  return createElement(hostRenderer, props);
}
