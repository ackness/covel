import fs from "node:fs/promises";

export async function fileExists(
  file: string,
  { followSymlinks = true }: { followSymlinks?: boolean } = {},
): Promise<boolean> {
  try {
    const stat = await (followSymlinks ? fs.stat(file) : fs.lstat(file));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
