import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Own staged bytes before build caches or packaging tools can overwrite them. */
export function detachStagingHardlinks(directory) {
  let detached = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      detached += detachStagingHardlinks(file);
    } else if (entry.isFile() && fs.statSync(file).nlink > 1) {
      // pnpm deploy can hardlink workspace files even in legacy mode. Replacing
      // only the staging directory entry preserves source bytes and permissions.
      const temporary = path.join(directory, `.stage-copy-${randomUUID()}`);
      try {
        fs.copyFileSync(file, temporary, fs.constants.COPYFILE_EXCL);
        fs.renameSync(temporary, file);
        detached++;
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    // Do not follow symlinks into a workspace or package store.
  }
  return detached;
}

/**
 * A gallery PNG that has a WebP of the same name beside it. The app shows the
 * WebP (`webFilename` in `media/gallery.json`); the PNG is the original the
 * repository keeps, and no code reads it.
 */
export function isGalleryOriginal(file) {
  return (
    /[\\/]media[\\/]gallery[\\/][^\\/]+\.png$/i.test(file) &&
    fs.existsSync(file.replace(/\.png$/i, ".webp"))
  );
}
