/** The published documentation site (apps/docs). */
const DOCS_ROOT = "https://covel.cc/docs/";

/**
 * A documentation page in the reader's language. The Chinese pages are the
 * source; every other language reads the English edition.
 *
 * @param page Path under `docs/` without the `.md` suffix, e.g. `start/models`.
 */
export function docsPageUrl(page: string, language: string): string {
  const edition = language.toLowerCase().startsWith("zh") ? "" : "en/";
  return `${DOCS_ROOT}${edition}${page}`;
}

/** What players on a shared server should know about their data and keys. */
export const SHARED_SERVER_DOCS_PAGE = "start/hosted-trial";
