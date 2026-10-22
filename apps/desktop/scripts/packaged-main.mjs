import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as asar from "@electron/asar";

/** Check the bytes Electron will load, never the source checkout's dist tree. */
export function verifyPackagedMain(resources, expectedSha256) {
  const archive = path.join(resources, "app.asar");
  if (!fs.lstatSync(archive).isFile()) {
    throw new Error(
      `Packaged application archive must be a regular file: ${archive}`,
    );
  }
  // The upstream reader caches headers by path. Revalidation must see replaced
  // artifacts, rather than trusting a previous archive's header or file offsets.
  asar.uncache(archive);
  const main = "dist/main.mjs";
  for (const entry of ["package.json", main]) {
    const metadata = asar.statFile(archive, entry, false);
    if (
      metadata.link !== undefined ||
      metadata.files !== undefined ||
      metadata.unpacked
    ) {
      throw new Error(
        `Packaged application entry must be a packed regular file: ${entry}`,
      );
    }
  }
  const manifest = JSON.parse(
    asar.extractFile(archive, "package.json", false).toString("utf8"),
  );
  if (manifest.main !== main) {
    throw new Error(
      `Unexpected packaged application main entry: ${manifest.main}`,
    );
  }
  const digest = createHash("sha256")
    .update(asar.extractFile(archive, main, false))
    .digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(
      `Packaged main SHA256 mismatch: ${archive}/${main}. Rebuild the complete desktop application.`,
    );
  }
}
