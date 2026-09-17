import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

export const fixtureRoot = fileURLToPath(
  new URL("../../../../tests/third-party/lifecycle-probe/", import.meta.url),
);

/** Package the standalone fixture exactly as a user-supplied ZIP upload. */
export async function buildThirdPartyPluginZip(
  packageRoot = fixtureRoot,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const buffers: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => buffers.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(buffers)));
    zip.outputStream.on("error", reject);
  });
  const addDirectory = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(packageRoot, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await addDirectory(name);
      else if (entry.isFile()) {
        zip.addBuffer(await readFile(path.join(packageRoot, name)), name, {
          mtime: new Date("2026-01-01T00:00:00Z"),
        });
      } else throw new Error(`Unsupported package entry: ${name}`);
    }
  };
  await addDirectory("");
  zip.end();
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = fileURLToPath(
    new URL("../../../../test-results/lifecycle-probe.zip", import.meta.url),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, await buildThirdPartyPluginZip());
  console.log("Created test-results/lifecycle-probe.zip");
}
