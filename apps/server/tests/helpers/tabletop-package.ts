import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildThirdPartyPluginZip } from "./third-party-package.js";

export const tabletopSource = fileURLToPath(
  new URL("../../../../plugins/tabletop-rules/", import.meta.url),
);
export const tabletopProbeId = "tabletop-probe";

/** Change only package identity, proving public contracts do not depend on an official ID. */
export async function buildTabletopProbeZip(): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), "tabletop-package-"));
  try {
    await cp(tabletopSource, root, {
      recursive: true,
      filter: (source) => !source.includes("node_modules"),
    });
    async function renameManifests(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await renameManifests(target);
        else if (entry.name === "PLUGIN.md" || entry.name.endsWith(".json")) {
          await writeFile(
            target,
            (await readFile(target, "utf8")).replaceAll(
              "tabletop-rules",
              tabletopProbeId,
            ),
          );
        }
      }
    }
    await renameManifests(root);
    return await buildThirdPartyPluginZip(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(tabletopSource, "../../test-results");
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, "tabletop-probe.zip"),
    await buildTabletopProbeZip(),
  );
  await writeFile(
    path.join(destination, "tabletop-rules.zip"),
    await buildThirdPartyPluginZip(tabletopSource),
  );
  console.log("Created test-results/tabletop-{rules,probe}.zip");
}
