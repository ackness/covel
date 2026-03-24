import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadWebModule<TModule>(relativePathFromSrcRoot: string): Promise<TModule> {
  const absolutePath = resolve(process.cwd(), "apps/web/src", relativePathFromSrcRoot);

  try {
    return await import(pathToFileURL(absolutePath).href) as TModule;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Missing or invalid apps/web implementation at ${absolutePath}: ${reason}`,
      {
        cause: error
      }
    );
  }
}
