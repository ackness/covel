import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { githubPluginSourceSchema } from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";

const receiptSchema = z.object({
  source: githubPluginSourceSchema,
  version: z.string().nullable(),
});
export const installedPluginRoutes = new Hono();

// The boot registry cannot show pending installs or removals. Read directory
// names and installer receipts only; never import pending plugin code.
installedPluginRoutes.get("/plugins", async (c) => {
  const root = resolveUserResourceDirs().plugins;
  const dirs = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const items = await Promise.all(
    dirs
      .filter(
        (dir) =>
          dir.isDirectory() && /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(dir.name),
      )
      .map(async (dir) => {
        const receipt = await readFile(
          path.join(root, dir.name, ".covel-install.json"),
          "utf8",
        )
          .then((text) => receiptSchema.parse(JSON.parse(text)))
          .catch(() => null);
        return {
          id: dir.name,
          version: receipt?.version ?? null,
          source: receipt?.source ?? null,
        };
      }),
  );
  return c.json({ items: items.sort((a, b) => a.id.localeCompare(b.id)) });
});
