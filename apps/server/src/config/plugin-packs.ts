import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { pluginPackSchema, type PluginPack } from "@covel/shared";

function readBuiltinPacks(): readonly PluginPack[] {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = path.join(directory, "packs", "builtin.yaml");
    if (existsSync(file))
      return pluginPackSchema.array().parse(parse(readFileSync(file, "utf-8")));
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Builtin plugin pack data is missing");
    directory = parent;
  }
}
/** Product presets are authored as data, independently of the activation resolver. */
export const BUILTIN_PLUGIN_PACKS = readBuiltinPacks();
