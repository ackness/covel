import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isInsideRoot(
  rootRealPath: string,
  candidateRealPath: string,
): boolean {
  const rel = path.relative(rootRealPath, candidateRealPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function resolveContainedPath(
  root: string,
  relativePath: string,
  options?: { rejectSymlinks?: boolean },
): Promise<string | null> {
  if (path.isAbsolute(relativePath)) return null;

  const rootRealPath = await realpath(root);
  const resolved = path.resolve(rootRealPath, relativePath);
  const lexicalRel = path.relative(rootRealPath, resolved);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
    return null;
  }

  let stat;
  try {
    stat = await lstat(resolved);
  } catch {
    return null;
  }

  if (options?.rejectSymlinks && stat.isSymbolicLink()) return null;

  const realResolved = await realpath(resolved);
  return isInsideRoot(rootRealPath, realResolved) ? realResolved : null;
}

/**
 * Why `resolveContainedPath` gives no path for `relativePath`, so that a
 * message can tell a file that is not there from a path that is not allowed.
 */
export async function explainUnresolvedPath(
  root: string,
  relativePath: string,
): Promise<"missing" | "symlink" | "outside"> {
  if (path.isAbsolute(relativePath)) return "outside";
  const rootRealPath = await realpath(root);
  const resolved = path.resolve(rootRealPath, relativePath);
  const lexicalRel = path.relative(rootRealPath, resolved);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel))
    return "outside";
  try {
    return (await lstat(resolved)).isSymbolicLink() ? "symlink" : "outside";
  } catch {
    return "missing";
  }
}
