import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const guidesRoot = path.resolve(import.meta.dirname, "../../../docs/guide");

it.each([
  { guide: "plugin-authoring.md", id: "my-plugin", multiRuntime: false },
  { guide: "plugin-authoring-agent.md", id: "notebook", multiRuntime: false },
  {
    guide: "plugin-authoring-advanced.md",
    id: "fact-index",
    multiRuntime: true,
  },
])(
  "validates the complete primary package example in $guide",
  async ({ guide, id, multiRuntime }) => {
    const document = await readFile(path.join(guidesRoot, guide), "utf8");
    const manifests = [
      ...document.matchAll(/```yaml\n(---\n[\s\S]*?)\n```/g),
    ].map((match) => match[1]!);
    expect(manifests.length).toBeGreaterThanOrEqual(multiRuntime ? 3 : 1);
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "covel-guide-example-"),
    );
    const root = path.join(temporary, id);
    async function write(file: string, content: string) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    try {
      await write("PLUGIN.md", manifests[0]!);
      await write("package.json", JSON.stringify({ name: id, type: "module" }));
      await write("README.md", "Guide package fixture.");
      // The guides describe these support files separately. Manifest references
      // still use the exact paths and declarations extracted from the document.
      if (guide === "plugin-authoring-agent.md") {
        await write("server/index.js", "export default () => {};\n");
        await write(
          "schemas/note.schema.json",
          JSON.stringify({
            type: "object",
            required: ["id", "text"],
            properties: { id: { type: "string" }, text: { type: "string" } },
          }),
        );
      }
      if (multiRuntime) {
        await write(
          "schemas/facts.schema.json",
          JSON.stringify({ type: "object" }),
        );
        await write("runtimes/extract/RUNTIME.md", manifests[1]!);
        await write("runtimes/query/RUNTIME.md", manifests[2]!);
        await write(
          "runtimes/query/handler.js",
          "export default () => ({ outcome: 'success', value: {} });\n",
        );
      }
      let diagnostics = "";
      const status = await runValidateManifest([root], {
        stdout: { write: () => {} },
        stderr: { write: (message) => (diagnostics += message) },
      });
      expect(status, diagnostics).toBe(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
