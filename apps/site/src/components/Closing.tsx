import type { Copy } from "../copy.js";
import { asset, CHANGELOG_URL, DOCS_URL, REPO_URL } from "../links.js";
import { container } from "./ui.js";

export function Closing({ copy }: { copy: Copy }) {
  return (
    <footer className="border-t border-line py-10">
      <div
        className={`${container} flex flex-col gap-6 text-sm text-muted sm:flex-row sm:items-center sm:justify-between`}
      >
        <div className="flex items-center gap-2.5">
          <img src={asset("icon.png")} alt="" className="h-6 w-6 rounded-md" />
          <span>{copy.footer.license}</span>
        </div>
        <nav className="flex gap-6" aria-label="Footer">
          <a
            className="transition hover:text-ink"
            href={`${DOCS_URL}${copy.meta.docsPath}`}
          >
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
  );
}
