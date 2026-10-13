export const REPO_URL = "https://github.com/ackness/covel";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const CHANGELOG_URL = `${REPO_URL}/blob/main/docs/CHANGELOG.md`;

/** A repository path, such as `docs/plugins/essentials.md`, on GitHub. */
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

/**
 * A file in `public/`, such as `screens/text-mode.webp`, under the base path
 * the site is built for (`SITE_BASE`, `/covel/` on GitHub Pages).
 */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

/**
 * The documentation site (apps/docs), published under `docs/` of this site.
 * In development it is the docs dev server, since this one does not serve it.
 */
export const DOCS_URL = import.meta.env.DEV
  ? `http://localhost:5175${import.meta.env.BASE_URL}docs/`
  : asset("docs/");
