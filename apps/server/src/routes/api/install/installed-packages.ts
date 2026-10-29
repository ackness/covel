import { compareText } from "@covel/shared";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { checkPackageIntegrity, readReceipt } from "./package-files.js";
import { sourceIsTrusted } from "./github-preview.js";
import { pendingPackageUpdate } from "./package-updates.js";

export function createInstalledPackageRoutes(kind: "plugin" | "world") {
  const installedPluginRoutes = new Hono();

  // The boot registry cannot show pending installs or removals. Read directory
  // names and installer receipts only; never import pending plugin code.
  installedPluginRoutes.get(
    kind === "world" ? "/worlds" : "/plugins",
    async (c) => {
      const root =
        resolveUserResourceDirs()[kind === "world" ? "worlds" : "plugins"];
      const dirs = await readdir(root, { withFileTypes: true }).catch(
        (error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      const candidates = dirs.filter(
        (dir) =>
          dir.isDirectory() && /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(dir.name),
      );
      const items = [];
      for (let offset = 0; offset < candidates.length; offset += 4) {
        items.push(
          ...(await Promise.all(
            candidates.slice(offset, offset + 4).map(async (dir) => {
              const directory = path.join(root, dir.name);
              const checked =
                kind === "plugin"
                  ? await checkPackageIntegrity(directory)
                  : undefined;
              if (checked?.status === "unreadable")
                console.warn(
                  `[trusted-sources] Cannot read installed package ${dir.name}`,
                );
              const receipt =
                checked?.receipt ??
                (await readReceipt(directory).catch(() => null));
              const pendingUpdate = await pendingPackageUpdate(root, dir.name);
              return {
                id: dir.name,
                version: receipt?.version ?? null,
                source: receipt?.source ?? null,
                pendingUpdate,
                integrity: checked?.status ?? "no-receipt",
                trustedSource:
                  kind === "plugin" &&
                  receipt !== null &&
                  sourceIsTrusted(c, receipt.source.repository),
              };
            }),
          )),
        );
      }
      return c.json({ items: items.sort((a, b) => compareText(a.id, b.id)) });
    },
  );

  return installedPluginRoutes;
}
