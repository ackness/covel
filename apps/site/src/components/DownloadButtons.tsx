import { ArrowRight, Download } from "lucide-react";
import type { Copy } from "../copy.js";
import type { DownloadLinks } from "../download.js";
import { RELEASES_URL, REPO_URL } from "../links.js";
import { primaryButton, secondaryButton } from "./ui.js";

// Neither build is signed. macOS reports a downloaded copy as damaged until
// its quarantine attribute is removed; Windows SmartScreen needs two clicks.
const MAC_QUARANTINE_COMMAND =
  "xattr -dr com.apple.quarantine /Applications/Covel.app";

export function DownloadButtons({
  copy,
  download,
}: {
  copy: Copy;
  download: DownloadLinks;
}) {
  const label = download.platform
    ? copy.hero.primaryFor[download.platform]
    : copy.hero.primary;
  const smallLink =
    "underline-offset-4 transition hover:text-ink hover:underline";
  return (
    <div className="mt-9 flex flex-col items-center gap-4">
      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <a href={download.href} className={primaryButton}>
          <Download className="h-4 w-4" />
          {label}
        </a>
        <a href={REPO_URL} className={secondaryButton}>
          {copy.hero.secondary}
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
      {download.platform ? (
        <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted">
          {download.portable ? (
            <a className={smallLink} href={download.portable}>
              {copy.hero.portable}
            </a>
          ) : null}
          <a className={smallLink} href={RELEASES_URL}>
            {copy.hero.otherPlatforms}
          </a>
        </p>
      ) : null}
      {download.platform ? (
        <details className="max-w-md text-xs text-muted">
          <summary className={`cursor-pointer ${smallLink}`}>
            {copy.hero.openHelp[download.platform].summary}
          </summary>
          <p className="mt-2 text-left leading-relaxed">
            {copy.hero.openHelp[download.platform].body}
          </p>
          {download.platform === "mac" ? (
            <code className="mt-2 block overflow-x-auto rounded-md border border-current/20 px-3 py-2 text-left font-mono whitespace-nowrap select-all">
              {MAC_QUARANTINE_COMMAND}
            </code>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
