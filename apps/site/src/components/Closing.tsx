import type { Copy } from "../copy.js";
import type { DownloadLinks } from "../download.js";
import { DownloadButtons } from "./DownloadButtons.js";
import { CHANGELOG_URL, DOCS_URL, REPO_URL } from "../links.js";
import { container } from "./ui.js";

export function Closing({
  copy,
  download,
}: {
  copy: Copy;
  download: DownloadLinks;
}) {
  return (
    <>
      <section
        aria-labelledby="cta-title"
        className="border-t border-line py-24 sm:py-32"
      >
        <div className={container}>
          <div className="grain relative overflow-hidden rounded-3xl border border-line bg-raised px-6 py-16 text-center sm:px-12 sm:py-20">
            <h2
              id="cta-title"
              className="font-display text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
            >
              {copy.cta.title}
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
              {copy.cta.body}
            </p>
            <DownloadButtons copy={copy} download={download} />
          </div>
        </div>
      </section>
      <footer className="border-t border-line py-10">
        <div
          className={`${container} flex flex-col gap-6 text-sm text-muted sm:flex-row sm:items-center sm:justify-between`}
        >
          <div className="flex items-center gap-2.5">
            <img src="/icon.png" alt="" className="h-6 w-6 rounded-md" />
            <span>{copy.footer.license}</span>
          </div>
          <nav className="flex gap-6" aria-label="Footer">
            <a className="transition hover:text-ink" href={DOCS_URL}>
              {copy.footer.docs}
            </a>
            <a className="transition hover:text-ink" href={CHANGELOG_URL}>
              {copy.footer.changelog}
            </a>
            <a className="transition hover:text-ink" href={REPO_URL}>
              {copy.footer.source}
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
