import { useEffect, useState } from "react";
import { RELEASES_URL, REPO_URL } from "./links.js";

export type Platform = "mac" | "windows";

export interface DownloadLinks {
  /** The installer for the visitor's system, or the release page. */
  href: string;
  /** Known only when `href` is an installer. */
  platform?: Platform;
  /** The Windows build that runs without installing, when there is one. */
  portable?: string;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_URL.replace(
  "https://github.com/",
  "",
)}/releases/latest`;

// The release workflow names files `Covel-electron-<version>-<os>-<arch>.<ext>`
// and the Windows portable build `…-win-x64-portable.exe`
// (apps/desktop/electron-builder.yml). The macOS zip is left to the release
// page.
const INSTALLER: Record<Platform, RegExp> = {
  mac: /-mac-arm64\.dmg$/,
  windows: /-win-x64\.exe$/,
};
const PORTABLE = /-win-x64-portable\.exe$/;

export function detectPlatform(
  nav: Pick<Navigator, "userAgent"> & {
    userAgentData?: { platform?: string; mobile?: boolean };
  },
): Platform | undefined {
  const data = nav.userAgentData;
  if (data?.mobile) return undefined;
  const platform = data?.platform ?? "";
  const agent = nav.userAgent;
  // Phones and tablets cannot run either installer.
  if (/iPhone|iPad|iPod|Android/i.test(agent)) return undefined;
  if (/mac/i.test(platform) || /Macintosh|Mac OS X/i.test(agent)) return "mac";
  if (/win/i.test(platform) || /Windows/i.test(agent)) return "windows";
  return undefined;
}

function find(
  assets: readonly ReleaseAsset[],
  pattern: RegExp,
): string | undefined {
  return assets.find((asset) => pattern.test(asset.name))?.browser_download_url;
}

/** The links for one system, or `undefined` when its installer is missing. */
export function pickDownload(
  assets: readonly ReleaseAsset[],
  platform: Platform,
): DownloadLinks | undefined {
  const href = find(assets, INSTALLER[platform]);
  if (!href) return undefined;
  const portable = platform === "windows" ? find(assets, PORTABLE) : undefined;
  return { href, platform, ...(portable ? { portable } : {}) };
}

/**
 * Starts as a link to the latest release page and, once GitHub answers,
 * becomes the installer from that release for the visitor's system. Any
 * failure (rate limit, offline, no matching file) keeps the release page.
 */
export function useDownload(): DownloadLinks {
  const [download, setDownload] = useState<DownloadLinks>({
    href: RELEASES_URL,
  });

  useEffect(() => {
    const platform = detectPlatform(navigator);
    if (!platform) return;
    const controller = new AbortController();
    void fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((release: { assets?: ReleaseAsset[] } | undefined) => {
        const links = pickDownload(release?.assets ?? [], platform);
        if (links) setDownload(links);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return download;
}
