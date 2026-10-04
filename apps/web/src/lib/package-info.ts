import {
  WORLD_PACKAGE_INFO_KEY,
  isPackageLinkUrl,
  packageInfoSchema,
  type PackageInfo,
  type PluginSummary,
} from "@covel/shared";
import type { TFunction } from "i18next";
import { requestConfirm } from "@/lib/confirm-channel.js";
import type { WorldRecord } from "@/services/api.js";

/** A world's version and credits, from the record its manifest was read into. */
export function worldPackageInfo(
  world: Pick<WorldRecord, "metadata"> | null | undefined,
): PackageInfo | undefined {
  const parsed = packageInfoSchema.safeParse(
    world?.metadata?.[WORLD_PACKAGE_INFO_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

/** A plugin's version and credits. */
export function pluginPackageInfo(
  plugin: Pick<PluginSummary, "version" | "author" | "license" | "homepage">,
): PackageInfo {
  return {
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
    ...(plugin.license ? { license: plugin.license } : {}),
    ...(plugin.homepage ? { homepage: plugin.homepage } : {}),
  };
}

/** "Jane Doe · v1.2.0": the one line a list shows about a package. */
export function packageByline(
  info: PackageInfo | undefined,
  t: TFunction,
): string {
  return [
    info?.author?.name,
    info?.version ? t("package.version", { version: info.version }) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Open a link from a package's credits. The address comes from the package
 * author, so the player first sees where it goes and that Covel has not
 * checked it. The host name is shown in its ASCII form, which makes a
 * look-alike name in another script visible.
 */
export async function openPackageLink(
  url: string,
  packageName: string,
  t: TFunction,
): Promise<void> {
  if (!isPackageLinkUrl(url)) return;
  const approved = await requestConfirm({
    title: t("package.link.title"),
    message: [
      t("package.link.message", { package: packageName }),
      "",
      url,
      t("package.link.site", { host: new URL(url).hostname }),
    ].join("\n"),
    confirmLabel: t("package.link.confirm"),
    cancelLabel: t("common.cancel"),
  });
  if (approved) window.open(url, "_blank", "noopener,noreferrer");
}
