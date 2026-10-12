#!/usr/bin/env node
/**
 * encode-world-webp.mjs — turn hand-made PNG art into the WebP a world ships.
 *
 * generate-portraits.mjs and generate-scenes.mjs write WebP themselves. Use
 * this for a picture made or edited elsewhere: it writes `<name>.webp` beside
 * each PNG and leaves the PNG, which Git ignores. Delete the PNG before
 * starting the app, or the world imports both files. Then refresh the hashes
 * with emit-presence.mjs / emit-scenes.mjs.
 *
 * Usage: node scripts/encode-world-webp.mjs <file.png>...
 */
import { readFile, writeFile } from "node:fs/promises";
import { encodeWebp } from "./lib/webp-image.mjs";

const files = process.argv.slice(2);
if (files.length === 0 || files.some((file) => !/\.png$/i.test(file))) {
  console.error("usage: node scripts/encode-world-webp.mjs <file.png>...");
  process.exit(1);
}

for (const file of files) {
  const png = await readFile(file);
  const webp = await encodeWebp(png);
  const target = file.replace(/\.png$/i, ".webp");
  await writeFile(target, webp);
  console.log(
    `${target}  ${(png.length / 1024).toFixed(0)} KB → ${(webp.length / 1024).toFixed(0)} KB`,
  );
}
