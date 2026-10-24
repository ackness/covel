import { useEffect, useState } from "react";
import { RELEASES_URL, REPO_URL } from "./links.js";

export type Platform = "mac" | "windows";

export interface DownloadLinks {
  /** The installer for the visitor's system, or the release page. */
  href: string;
  files?: DownloadFile[];
  status?: "loading" | "ready" | "unavailable";
  detected?: Platform;
  /** Known only when `href` is an installer. */
  platform?: Platform;
  /** Single-file Windows launcher; extracts the app on every launch. */
  portable?: string;
  /** Windows archive to extract once and run from its folder. */
  zip?: string;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_URL.replace(
  "https://github.com/",
  "",
)}/releases/latest`;

// The release workflow names files `Covel-electron-<version>-<os>-<arch>.<ext>`
// and the Windows portable build `…-win-x64-portable.exe`
// (apps/desktop/electron-builder.yml). The catalog also lists macOS ZIPs.
const INSTALLER: Record<Platform, RegExp> = {
  mac: /-mac-arm64\.dmg$/,
  windows: /-win-x64\.exe$/,
};
const PORTABLE = /-win-x64-portable\.exe$/;
const WINDOWS_ZIP = /-win-x64\.zip$/;

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
  const zip = platform === "windows" ? find(assets, WINDOWS_ZIP) : undefined;
  return {
    href,
    platform,
    ...(portable ? { portable } : {}),
    ...(zip ? { zip } : {}),
  };
}

export interface DownloadFile {
  name: string;
  href: string;
  platform: Platform;
  kind: "installer" | "archive" | "portable";
}

/** Catalog every supported artifact, even if its platform has no installer. */
export function listDownloads(assets: readonly ReleaseAsset[]): DownloadFile[] {
  const formats = [
    { platform: "mac", kind: "installer", pattern: INSTALLER.mac },
    { platform: "mac", kind: "archive", pattern: /-mac-arm64\.zip$/ },
    { platform: "windows", kind: "installer", pattern: INSTALLER.windows },
    { platform: "windows", kind: "archive", pattern: WINDOWS_ZIP },
    { platform: "windows", kind: "portable", pattern: PORTABLE },
  ] as const;
  return formats.flatMap(({ platform, kind, pattern }) => {
    const file = assets.find((asset) => pattern.test(asset.name));
    return file
      ? [{ name: file.name, href: file.browser_download_url, platform, kind }]
      : [];
  });
}

/** Treat the network response as untrusted; malformed entries cannot become links. */
export function releaseAssets(value: unknown): ReleaseAsset[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  )
    return [];
  return value.assets.filter((item: unknown): item is ReleaseAsset => {
    if (
      !item ||
      typeof item !== "object" ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      !("browser_download_url" in item) ||
      typeof item.browser_download_url !== "string"
    )
      return false;
    try {
      return new URL(item.browser_download_url).protocol === "https:";
    } catch {
      return false;
    }
  });
}

/** Fetch once for every visitor. Detection only chooses the primary shortcut. */
export function useDownload(): DownloadLinks {
  const [download, setDownload] = useState<DownloadLinks>({
    href: RELEASES_URL,
    status: "loading",
  });
  useEffect(() => {
    const detected = detectPlatform(navigator);
    const controller = new AbortController();
    // A stalled request must still expose a useful fallback.
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let active = true;
    void fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((release: unknown) => {
        if (!active) return;
        const assets = releaseAssets(release);
        const files = listDownloads(assets);
        const primary = detected ? pickDownload(assets, detected) : undefined;
        setDownload({
          ...primary,
          href: primary?.href ?? RELEASES_URL,
          files,
          detected,
          status: files.length ? "ready" : "unavailable",
        });
      })
      .catch(() => {
        if (active)
          setDownload({ href: RELEASES_URL, detected, status: "unavailable" });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);
  return download;
}
