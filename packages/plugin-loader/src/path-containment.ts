import fs from "node:fs/promises";
import path from "node:path";

/** Lexical containment; callers resolve symlinks when paths exist. */
export function isPathInside(
  root: string,
  target: string,
  { allowRoot = false }: { allowRoot?: boolean } = {},
): boolean {
  const relative = path.relative(root, target);
  return (
    (allowRoot || relative !== "") &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/** Resolve symlinks before checking containment; missing paths use lexical checks. */
export async function assertInsideRoot(
  root: string,
  target: string,
  message: string,
): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(root).catch(() => path.resolve(root)),
    fs.realpath(target).catch(() => path.resolve(target)),
  ]);
  if (!isPathInside(realRoot, realTarget, { allowRoot: true }))
    throw new Error(message);
}
