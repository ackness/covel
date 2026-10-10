import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");
const PLUGIN_ID = path.basename(PLUGIN_DIR);

/** The `{{ … }}` placeholders of a prompt body, each one time, sorted. */
function placeholders(body) {
  return [
    ...new Set(
      [...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]),
    ),
  ].sort();
}

describe(`${PLUGIN_ID} package`, () => {
  let definition;
  let manifest;
  let english;
  let chinese;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(path.dirname(PLUGIN_DIR));
    const discovery = discoveries.find((item) => item.id === PLUGIN_ID);
    definition = await loadPluginDefinition(discovery);
    manifest = definition.manifests[0].manifest;
    english = (await loadRuntime(discovery, manifest.name)).promptTemplate;
    // The variant holds only translated text: its body follows the frontmatter.
    chinese = readFileSync(path.join(PLUGIN_DIR, "PLUGIN.zh.md"), "utf8")
      .split(/^---$/m)
      .slice(2)
      .join("---");
  });

  it("is the story runtime of the narrative stage and provides the narrative engine", () => {
    expect(manifest).toMatchObject({
      name: PLUGIN_ID,
      runtimeType: "agent",
      stage: "narrative",
      outputKind: "story",
    });
    expect(
      definition.packageManifest.plugin.provides.map((item) =>
        typeof item === "string" ? item : item.contract,
      ),
    ).toContain("narrative-engine@1");
    // Two engines in one session would both write the turn.
    expect(definition.packageManifest.plugin.conflicts).toContain(
      "narrative-engine@1",
    );
  });

  it("hands every player setting to the prompt, in both languages", () => {
    const settings = definition.packageManifest.manifest.userSettings ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const { key } of settings) {
      expect(placeholders(english)).toContain(`userSettings.${key}`);
      expect(placeholders(chinese)).toContain(`userSettings.${key}`);
    }
  });

  it("fills the same placeholders in the Chinese body as in the English one", () => {
    expect(placeholders(chinese)).toEqual(placeholders(english));
  });

  it("needs no companion plugin that the player may turn off", () => {
    const companions = [
      "branch-reply@1",
      "living-world-rules@1",
      "character-blueprint@1",
      "character-presence@1",
    ];
    for (const contract of definition.packageManifest.plugin.requires ?? [])
      expect(companions).not.toContain(contract);
  });
});
