import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildThirdPartyPluginZip } from "./third-party-package.js";

export const notesExampleRoot = fileURLToPath(
  new URL("../../../../examples/composable-notes/plugins/", import.meta.url),
);
export const notesExampleIds = [
  "notes-workbench",
  "note-format-clean",
  "note-format-outline",
] as const;

export function buildNotesExampleZip(id: (typeof notesExampleIds)[number]) {
  return buildThirdPartyPluginZip(path.join(notesExampleRoot, id));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = fileURLToPath(
    new URL("../../../../test-results/composable-notes/", import.meta.url),
  );
  await mkdir(output, { recursive: true });
  for (const id of notesExampleIds) {
    await writeFile(
      path.join(output, `${id}.zip`),
      await buildNotesExampleZip(id),
    );
    console.log(`Created test-results/composable-notes/${id}.zip`);
  }
}
