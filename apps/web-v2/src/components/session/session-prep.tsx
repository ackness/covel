/**
 * SessionPrep — pre-game preparation screen rendered via json-render.
 *
 * Shows world details, plugin list, and "开始冒险" button.
 * All UI uses the same json-render catalog as plugin panels.
 */

import { useMemo } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import type { WorldRecord, PluginInfo } from "@/stores/session-store.js";

interface SessionPrepProps {
  world: WorldRecord;
  plugins: PluginInfo[];
  onStart: () => void;
  onBack: () => void;
}

function buildPrepSpec(world: WorldRecord, plugins: PluginInfo[]): Record<string, unknown> {
  return {
    type: "Stack",
    props: { gap: "md" },
    children: [
      // Back button
      {
        type: "Button",
        props: { label: "← 返回选择世界", variant: "default" },
        on: { click: { action: "back" } },
      },
      // World info card
      {
        type: "Card",
        children: [
          {
            type: "Stack",
            props: { gap: "sm" },
            children: [
              {
                type: "Row",
                props: { gap: "sm" },
                children: [
                  { type: "Icon", props: { name: "globe", size: "md" } },
                  { type: "Text", props: { content: world.name, weight: "bold", size: "lg" } },
                ],
              },
              { type: "Text", props: { content: world.description, variant: "muted" } },
              ...(world.tags?.length ? [{
                type: "Row",
                props: { gap: "xs" },
                children: world.tags.map((tag) => ({
                  type: "Badge",
                  props: { label: tag, color: "blue" },
                })),
              }] : []),
            ],
          },
        ],
      },
      // Plugin list
      {
        type: "Card",
        children: [
          {
            type: "Stack",
            props: { gap: "sm" },
            children: [
              {
                type: "Row",
                props: { gap: "sm" },
                children: [
                  { type: "Icon", props: { name: "puzzle", size: "sm" } },
                  { type: "Text", props: { content: `插件 (${plugins.length})`, weight: "bold", size: "sm" } },
                ],
              },
              { type: "Separator" },
              ...plugins.map((p) => ({
                type: "Row",
                props: { gap: "sm" },
                children: [
                  { type: "Icon", props: { name: "check-circle", size: "xs" } },
                  { type: "Text", props: { content: p.displayName || p.name, size: "sm" } },
                ],
              })),
            ],
          },
        ],
      },
      // Start button
      {
        type: "SubmitButton",
        props: { label: "开始冒险" },
        on: { click: { action: "start" } },
      },
    ],
  };
}

export function SessionPrep({ world, plugins, onStart, onBack }: SessionPrepProps) {
  const spec = useMemo(() => {
    try {
      return nestedToFlat(buildPrepSpec(world, plugins));
    } catch {
      return null;
    }
  }, [world, plugins]);

  const handlers = useMemo(() => ({
    start: async () => { onStart(); },
    back: async () => { onBack(); },
  }), [onStart, onBack]);

  if (!spec) return null;

  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-lg w-full px-6">
        <JSONUIProvider registry={covelRegistry} initialState={{}} handlers={handlers}>
          <Renderer spec={spec} registry={covelRegistry} />
        </JSONUIProvider>
      </div>
    </div>
  );
}
