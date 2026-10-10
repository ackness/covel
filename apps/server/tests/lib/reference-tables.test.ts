import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginMd } from "@covel/plugin-loader";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const PLUGINS = path.join(ROOT, "plugins");

interface BundledPlugin {
  readonly id: string;
  readonly tools: readonly string[];
  /** Panel ids from the right/left UI specs the root manifest contributes. */
  readonly panelIds: readonly string[];
}

function bundledPlugins(): BundledPlugin[] {
  const found: BundledPlugin[] = [];
  for (const dir of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith("_")) continue;
    const file = path.join(PLUGINS, dir.name, "PLUGIN.md");
    if (!existsSync(file)) continue;
    const { plugin } = parsePluginMd(readFileSync(file, "utf8"), file);
    const contributes = plugin.contributes;
    const ui = contributes?.ui;
    const specs = [...(ui?.right ?? []), ...(ui?.left ?? [])];
    found.push({
      id: dir.name,
      tools: contributes?.tools ?? [],
      panelIds: specs.map((spec) => {
        const parsed: unknown = JSON.parse(
          readFileSync(path.join(PLUGINS, dir.name, spec), "utf8"),
        );
        const id = (parsed as { id?: unknown }).id;
        if (typeof id !== "string") {
          throw new Error(`${dir.name}/${spec} has no panel id`);
        }
        return id;
      }),
    });
  }
  return found;
}

/** The cells of every table row whose first cell is a plain or bold name. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, "$1")),
    );
}

describe("reference tables list what the bundled plugins contribute", () => {
  const plugins = bundledPlugins();

  it("lists every plugin tool in docs/reference/tools.md", () => {
    const rows = tableRows(
      readFileSync(path.join(ROOT, "docs/reference/tools.md"), "utf8"),
    );
    const listed = new Set(rows.map((cells) => `${cells[2]}/${cells[0]}`));
    const missing = plugins
      .flatMap((plugin) => plugin.tools.map((tool) => `${plugin.id}/${tool}`))
      .filter((entry) => !listed.has(entry));
    expect(missing, "add these rows to the tools overview table").toEqual([]);
  });

  it("lists every right and left panel in docs/reference/ui-panels.md", () => {
    const rows = tableRows(
      readFileSync(path.join(ROOT, "docs/reference/ui-panels.md"), "utf8"),
    );
    const listed = new Set(rows.map((cells) => cells[1]));
    const missing = plugins
      .flatMap((plugin) =>
        plugin.panelIds.map((panel) => `${plugin.id}: ${panel}`),
      )
      .filter((entry) => !listed.has(entry.split(": ")[1]));
    expect(missing, "add these panels to the registered panels table").toEqual(
      [],
    );
  });
});
