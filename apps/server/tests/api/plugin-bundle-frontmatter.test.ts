import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverPluginAt, loadPluginDefinition } from "@covel/plugin-loader";
import { STORY_OUTPUT_CONTRACT } from "@covel/shared";
import { frameworkContractSchemas } from "@covel/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  readPluginFrontmatter,
  validatePluginBundle,
} from "../../src/routes/api/install/plugin-bundle.js";

const entry = (relativePath: string, text: string) => ({
  relativePath,
  content: Buffer.from(text),
});
const root = [
  entry("package.json", '{"name":"@covel/plugin-probe","type":"module"}'),
  entry("PLUGIN.md", "---\nid: probe\nkind: plugin\ndescription: Probe\n---\n"),
];

describe("installation uses the shared manifest readers", () => {
  it.each([
    {
      name: "the framework schema with its own title",
      contracts: { [STORY_OUTPUT_CONTRACT]: { schema: "story.json" } },
      files: {
        "story.json": {
          ...frameworkContractSchemas[STORY_OUTPUT_CONTRACT],
          title: "Package copy",
        },
      },
    },
    {
      name: "a different framework schema",
      contracts: { [STORY_OUTPUT_CONTRACT]: { schema: "story.json" } },
      files: { "story.json": { type: "object" } },
      error: /framework-owned and cannot be shadowed/,
    },
    {
      name: "a missing declared schema",
      contracts: { [STORY_OUTPUT_CONTRACT]: { schema: "story.json" } },
      files: {},
      error: /contracts.*schema.*story\.json|story\.json.*contracts.*schema/,
    },
    {
      name: "a contract reference instead of a schema file",
      contracts: {
        [STORY_OUTPUT_CONTRACT]: {
          schema: `contract:${STORY_OUTPUT_CONTRACT}`,
        },
      },
      files: {},
      error: /expected a package-local schema file/,
    },
    {
      name: "different schema files for one data contract",
      contracts: { "records@1": { schema: "public.json" } },
      data: {
        records: { version: 1, accepts: ["records@1"], schema: "local.json" },
      },
      files: {
        "public.json": { type: "object" },
        "local.json": { type: "object" },
      },
      error:
        /data namespace records must use its accepted contract records@1 schema/,
    },
  ])(
    "agrees with disk loading for $name",
    async ({ contracts, data, files, error }) => {
      const manifest = {
        id: "probe",
        description: "Contract check",
        contracts,
        ...(data ? { contributes: { data } } : {}),
      };
      const filesInPackage = [
        entry("PLUGIN.md", `---\n${JSON.stringify(manifest)}\n---\n`),
        ...Object.entries(files).map(([name, schema]) =>
          entry(name, JSON.stringify(schema)),
        ),
      ];
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), "covel-contracts-"),
      );
      try {
        const dir = path.join(await fs.realpath(parent), "probe");
        await fs.mkdir(dir);
        for (const file of filesInPackage)
          await fs.writeFile(path.join(dir, file.relativePath), file.content);
        const discovery = (await discoverPluginAt(dir))!;
        if (error) {
          await expect(loadPluginDefinition(discovery)).rejects.toThrow(error);
          expect(() => validatePluginBundle(filesInPackage, new Set())).toThrow(
            error,
          );
        } else {
          await expect(loadPluginDefinition(discovery)).resolves.toBeDefined();
          expect(validatePluginBundle(filesInPackage, new Set()).pluginId).toBe(
            discovery.id,
          );
        }
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("accepts an empty YAML block in a prompt-only translation", () => {
    expect(() =>
      validatePluginBundle(
        [...root, entry("PLUGIN.zh.md", "---\n---\n翻译正文\n")],
        new Set(),
      ),
    ).not.toThrow();
  });

  it.each(["runtime.md", "RUNTIME.zh.md", "helper.js", "nested/helper.js"])(
    "diagnoses a runtime directory containing only %s",
    (filename) => {
      expect(() =>
        validatePluginBundle(
          [...root, entry(`runtimes/missing/${filename}`, "---\n---\n")],
          new Set(),
        ),
      ).toThrow("runtimes/missing/RUNTIME.md: missing runtime manifest");
    },
  );

  it("refuses a second automatic story runtime, as loading leaves it out", () => {
    const story = (id: string) =>
      entry(
        `runtimes/${id}/RUNTIME.md`,
        `---\ndescription: Teller ${id}\nschedule: { stage: narrative }\nio: { visibility: story }\n---\nTell the story.\n`,
      );
    expect(() =>
      validatePluginBundle([...root, story("one")], new Set()),
    ).not.toThrow();
    expect(() =>
      validatePluginBundle([...root, story("two"), story("one")], new Set()),
    ).toThrow(
      "probe/two is a second automatically scheduled story runtime in this package, and probe/one already provides narrative-engine@2",
    );
  });

  it("allows shared code outside runtimes/", () => {
    expect(() =>
      validatePluginBundle(
        [
          ...root,
          entry("lib/helper.js", "throw new Error('must not execute')"),
        ],
        new Set(),
      ),
    ).not.toThrow();
  });

  it.each(["js", "javascript", "yaml", "json"])(
    "rejects the %s engine directive before parsing",
    (engine) => {
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      const probe = "__covelInstallFrontmatterProbe";
      try {
        expect(() =>
          readPluginFrontmatter(
            `---${engine}\n(() => { globalThis.${probe} = true; return {}; })()\n---\n`,
          ),
        ).toThrow("plain YAML frontmatter");
        expect(globals[probe]).toBeUndefined();
      } finally {
        delete globals[probe];
      }
    },
  );
});
