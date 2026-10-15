import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vitest";
import { loadPluginUiSpec } from "../src/ui-spec.js";

function itemProps(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.component === "EntryCard")
    return record.props as Record<string, unknown>;
  for (const child of Object.values(record)) {
    const found = itemProps(child);
    if (found) return found;
  }
}

it.each([
  ["codex", "codex-panel.json", "monster", "Monsters", "怪物"],
  ["core-quest", "quest-log-panel.json", "active", "Active", "进行中"],
  [
    "living-world-rules",
    "living-world-rules-panel.json",
    "constant",
    "Constant",
    "恒常规则",
  ],
])(
  "loads %s badge labels from the plugin's own locale catalog",
  async (pluginId, file, value, en, zh) => {
    const root = fileURLToPath(
      new URL(`../../../plugins/${pluginId}/`, import.meta.url),
    );
    const spec = await loadPluginUiSpec(
      root,
      path.join(root, "ui", file),
      pluginId,
    );
    const props = itemProps(spec);
    expect(props?.categoryOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value, label: { en, zh } }),
      ]),
    );
    if (pluginId === "codex")
      expect(props?.rarityOptions).toEqual(
        expect.arrayContaining([
          { value: "legendary", tone: "warning", color: "amber" },
        ]),
      );
  },
);
