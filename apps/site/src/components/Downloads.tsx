import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy as CopyIcon,
  Download,
  Laptop,
  Monitor,
} from "lucide-react";
import type { Copy } from "../copy.js";
import type { DownloadFile, DownloadLinks, Platform } from "../download.js";
import { RELEASES_URL, TRIAL_URL } from "../links.js";
import { container, SectionHeading } from "./ui.js";

const PLATFORMS: {
  id: Platform;
  name: string;
  arch: string;
  icon: typeof Laptop;
  kinds: DownloadFile["kind"][];
}[] = [
  {
    id: "mac",
    name: "macOS",
    arch: "Apple silicon · arm64",
    icon: Laptop,
    kinds: ["installer", "archive"],
  },
  {
    id: "windows",
    name: "Windows",
    arch: "x64",
    icon: Monitor,
    kinds: ["installer", "archive", "portable"],
  },
];

export function Downloads({
  copy,
  download,
}: {
  copy: Copy;
  download: DownloadLinks;
}) {
  const [feedback, setFeedback] = useState<{
    href: string;
    success: boolean;
  }>();
  const text = copy.downloads;
  const copyLink = async (href: string) => {
    try {
      await navigator.clipboard.writeText(href);
      setFeedback({ href, success: true });
    } catch {
      setFeedback({ href, success: false });
    }
  };
  return (
    <section
      id="downloads"
      className="download-section border-t border-line py-24 sm:py-32"
      aria-labelledby="downloads-title"
    >
      <div className={`${container} download-layout`}>
        <div className="download-intro">
          <SectionHeading
            id="downloads-title"
            eyebrow={copy.nav.download}
            title={text.title}
          >
            {text.body}
          </SectionHeading>
          <a href={RELEASES_URL} className="download-release-link">
            {text.releases}
            <ArrowUpRight size={15} aria-hidden />
          </a>
          <a
            href={TRIAL_URL}
            className="download-release-link download-trial-link"
          >
            {text.trial}
            <ArrowUpRight size={15} aria-hidden />
          </a>
        </div>
        <div>
          <div className="download-catalog">
            {PLATFORMS.map(({ id, name, arch, icon: Icon, kinds }) => {
              const files =
                download.files?.filter((file) => file.platform === id) ?? [];
              return (
                <article
                  key={id}
                  className="download-platform"
                  aria-labelledby={`download-${id}`}
                >
                  <div className="download-platform-heading">
                    <span className="download-platform-icon">
                      <Icon size={23} aria-hidden />
                    </span>
                    <div>
                      <h3 id={`download-${id}`}>{name}</h3>
                      <p>{arch}</p>
                    </div>
                    {download.detected === id && (
                      <span className="download-system">
                        <span aria-hidden />
                        {text.recommended}
                      </span>
                    )}
                  </div>
                  <ul className="download-files">
                    {kinds.map((kind) => {
                      const file = files.find(
                        (candidate) => candidate.kind === kind,
                      );
                      const recommended = kind === "installer";
                      const description =
                        id === "windows"
                          ? kind === "installer"
                            ? text.installerHelp
                            : kind === "archive"
                              ? copy.hero.zipHelp
                              : copy.hero.portableHelp
                          : kind === "installer"
                            ? text.macInstallerHelp
                            : text.macArchiveHelp;
                      return (
                        <li
                          key={kind}
                          className="download-file"
                          data-available={!!file}
                        >
                          <div className="download-file-description">
                            <div className="download-file-heading">
                              <h4>{text[kind]}</h4>
                              {recommended && (
                                <span className="download-recommended">
                                  {text.installerRecommended}
                                </span>
                              )}
                            </div>
                            <p>{description}</p>
                          </div>
                          <div className="download-file-actions">
                            {file ? (
                              <>
                                <a
                                  href={file.href}
                                  title={file.name}
                                  aria-label={`${text.action} · ${name} · ${text[kind]}`}
                                  className="download-file-link"
                                  data-primary={recommended}
                                >
                                  <Download size={15} aria-hidden />
                                  <span>{text.action}</span>
                                </a>
                                <button
                                  type="button"
                                  className="download-copy"
                                  title={text.copy}
                                  aria-label={`${text.copy} · ${name} · ${text[kind]}`}
                                  onClick={() => void copyLink(file.href)}
                                >
                                  {feedback?.href === file.href &&
                                  feedback.success ? (
                                    <Check size={16} aria-hidden />
                                  ) : (
                                    <CopyIcon size={16} aria-hidden />
                                  )}
                                </button>
                              </>
                            ) : (
                              <span className="download-pending">
                                {download.status === "loading"
                                  ? text.checking
                                  : download.status === "ready"
                                    ? text.notPublished
                                    : text.notConfirmed}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {!files.length && (
                    <p className="download-unavailable">
                      {download.status === "loading"
                        ? text.loading
                        : download.status === "ready"
                          ? text.missing
                          : text.unavailable}
                    </p>
                  )}
                  {files.length > 0 && (
                    <details className="download-help">
                      <summary>{copy.hero.openHelp[id].summary}</summary>
                      <p>{copy.hero.openHelp[id].body}</p>
                      {id === "mac" && (
                        <code>
                          xattr -dr com.apple.quarantine /Applications/Covel.app
                        </code>
                      )}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <p role="status" className="download-feedback">
            {feedback ? (feedback.success ? text.copied : text.copyFailed) : ""}
          </p>
        </div>
      </div>
    </section>
  );
}
