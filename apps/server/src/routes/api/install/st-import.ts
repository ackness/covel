import path from "node:path";
import { lstat } from "node:fs/promises";
import { Hono } from "hono";
import { canonicalizeLocale, DEFAULT_LOCALE } from "@covel/shared";
import { requireAccess } from "../../../host-profile.js";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import {
  convertStImport,
  MAX_ST_FILE_BYTES,
} from "../../../world-import/st/convert.js";
import { StImportError } from "../../../world-import/st/report.js";
import {
  collectUpload,
  errorResponse,
  isBlobLike,
  rejectByContentLength,
} from "./shared.js";
import { activateWorldPackage, validateWorldBundle } from "./worlds.js";

export const stImportRoutes = new Hono();
stImportRoutes.post("/st-import", async (c) => {
  const denied = requireAccess(c, "world.write");
  if (denied) return denied;
  try {
    const tooLarge = rejectByContentLength(c.req.header("content-length"));
    if (tooLarge) throw tooLarge;
    const form = await c.req.formData();
    const uploads = form.getAll("file");
    if (!uploads.length || !uploads.every(isBlobLike))
      throw new StImportError(
        "files-required",
        'Multipart field "file" must contain files',
      );
    if (uploads.length > 8)
      throw new StImportError("files-limit", "At most 8 files may be imported");
    const rawLocale = form.get("locale") ?? DEFAULT_LOCALE;
    const locale =
      typeof rawLocale === "string" ? canonicalizeLocale(rawLocale) : undefined;
    if (!locale)
      throw new StImportError("locale-invalid", "Invalid BCP 47 locale");
    const worldName = form.get("name");
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const upload of uploads) {
      if (!isBlobLike(upload))
        throw new StImportError("files-required", "Expected an uploaded file");
      const bytes = await collectUpload(upload);
      if (bytes.byteLength > MAX_ST_FILE_BYTES)
        throw new StImportError("file-too-large", "File exceeds 8 MiB", 413);
      files.push({
        name:
          "name" in upload && typeof upload.name === "string"
            ? upload.name
            : "upload",
        bytes,
      });
    }
    const { entries, report } = await convertStImport({
      files,
      locale,
      ...(typeof worldName === "string" ? { worldName } : {}),
      async isIdTaken(id) {
        if (await c.get("store").getWorld(id)) return true;
        try {
          await lstat(path.join(resolveUserResourceDirs().worlds, id));
          return true;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return false;
          throw error;
        }
      },
    });
    const { worldId } = validateWorldBundle(entries, report.world.id);
    const preview = form.get("preview") === "true";
    if (!preview) await activateWorldPackage(c, worldId, entries);
    return c.json(
      {
        ok: true,
        preview,
        kind: "world",
        id: worldId,
        restartRequired: false,
        report,
      },
      preview ? 200 : 201,
    );
  } catch (error) {
    const { status, body } = errorResponse(error);
    if (status === 409)
      body.error =
        "World id is already taken; preview and try again, or choose another name";
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});
