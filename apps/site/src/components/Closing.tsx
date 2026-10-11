import { ArrowRight, Download } from "lucide-react";
import type { Copy } from "../copy.js";
import { CHANGELOG_URL, DOCS_URL, RELEASES_URL, REPO_URL } from "../links.js";
import { container, primaryButton, secondaryButton } from "./ui.js";

export function Closing({ copy }: { copy: Copy }) {
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
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={RELEASES_URL} className={primaryButton}>
                <Download className="h-4 w-4" />
                {copy.hero.primary}
              </a>
              <a href={REPO_URL} className={secondaryButton}>
                {copy.hero.secondary}
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
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
