export const REPO_URL = "https://github.com/ackness/covel";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
export const CHANGELOG_URL = `${REPO_URL}/blob/main/docs/CHANGELOG.md`;

/** A repository path, such as `docs/guide/plugin-authoring.md`, on GitHub. */
export function repoFile(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}
