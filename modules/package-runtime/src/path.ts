import { isAbsolute, relative, resolve } from "node:path";

import { PackageRuntimeError } from "./error.js";

export function resolvePackageRelativePath(packageRoot: string, candidatePath: string): string {
  if (isAbsolute(candidatePath)) {
    throw new PackageRuntimeError({
      code: "PATH_TRAVERSAL_BLOCKED",
      message: `Absolute paths are not allowed in package contributions: '${candidatePath}'.`,
      details: {
        candidatePath
      }
    });
  }

  const resolvedPath = resolve(packageRoot, candidatePath);
  const relativePath = relative(packageRoot, resolvedPath);

  if (relativePath.startsWith("..") || relativePath === "") {
    throw new PackageRuntimeError({
      code: "PATH_TRAVERSAL_BLOCKED",
      message: `Path traversal outside the package root is not allowed: '${candidatePath}'.`,
      details: {
        candidatePath,
        packageRoot
      }
    });
  }

  return resolvedPath;
}
