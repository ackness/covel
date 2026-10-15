import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parsePluginMd, parseRuntimeMd } from "../src/index.js";
import { validateRuntimeDeclarations } from "../src/static-validation.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const guidesRoot = path.resolve(import.meta.dirname, "../../../docs/plugins");

it.each([
  { guide: "essentials.md", id: "my-plugin", multiRuntime: false },
  { guide: "local-code.md", id: "notebook", multiRuntime: false },
  {
    guide: "advanced.md",
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
      // The guides ship no package.json: the folder name is the ID and the
      // version lives in PLUGIN.md.
      await write("PLUGIN.md", manifests[0]!);
      // The guides describe these support files separately. Manifest references
      // still use the exact paths and declarations extracted from the document.
      if (guide === "local-code.md") {
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
      let report = "";
      const status = await runValidateManifest([root], {
        stdout: { write: (message) => (report += message) },
        stderr: { write: (message) => (diagnostics += message) },
      });
      expect(status, diagnostics).toBe(0);
      // A guide example writes no field with its default value.
      expect(report).not.toContain("warning:");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

const repoRoot = path.resolve(guidesRoot, "../..");
const skillRoot = path.join(repoRoot, ".claude/skills/create-plugin");
const sdkRoot = path.join(repoRoot, "packages/plugin-handlers-utils/src");

it("keeps the skill's handler outcomes within the public SDK", async () => {
  const sdkResults = await readFile(
    path.join(sdkRoot, "handler-result.ts"),
    "utf8",
  );
  const supported = new Set(
    [...sdkResults.matchAll(/readonly outcome: "([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  );
  expect(supported.size).toBeGreaterThan(0);
  for (const file of ["SKILL.md", "references/runtime-context.md"]) {
    const text = await readFile(path.join(skillRoot, file), "utf8");
    const line = text
      .split("\n")
      .find(
        (line) =>
          line.includes("Supported outcomes") || line.includes("success /"),
      );
    expect(line, file).toBeDefined();
    const claimed = new Set(
      line?.match(/\b(success|suspended|skipped|failed|blocked)\b/g) ?? [],
    );
    expect(claimed, file).toEqual(supported);
  }
});

it("keeps the skill's scoped store calls within the public SDK", async () => {
  const sdkStore = await readFile(
    path.join(sdkRoot, "function-runtime.ts"),
    "utf8",
  );
  const store = sdkStore
    .split("export interface FunctionStoreView {")[1]
    ?.split("\n}")[0];
  expect(store).toBeDefined();
  const methods = new Map(
    [...store!.matchAll(/^  (\w+)\(([\s\S]*?)\):/gm)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
  const context = await readFile(
    path.join(skillRoot, "references/runtime-context.md"),
    "utf8",
  );
  const paragraph = context.match(/All plugin stores[\s\S]*?(?=\n\n)/)?.[0];
  expect(paragraph).toBeDefined();
  for (const [, name, params] of paragraph?.matchAll(/`(\w+)\(([^`]*)\)`/g) ??
    []) {
    const method = methods.get(name!);
    expect(
      method,
      `${name} must be a public scoped store method`,
    ).toBeDefined();
    if (params?.includes("?"))
      expect(method?.includes("?:"), `${name} has a required namespace`).toBe(
        true,
      );
  }
});

it("the skill's example local runtime binding validates inside its own package", async () => {
  const text = await readFile(
    path.join(skillRoot, "references/plugin-schema.md"),
    "utf8",
  );
  const runtimeId = text.match(/\{runtime: ([^}]+)\}/)?.[1];
  expect(runtimeId).toBeDefined();
  const root = parsePluginMd(
    "---\nid: sample-notes\nkind: plugin\ndescription: Probe\n---\n",
    "/sample-notes/PLUGIN.md",
  );
  const producer = parseRuntimeMd(
    "---\nschedule: {trigger: {type: manual}}\nfunction: {handler: ./handler.js}\n---\n",
    "/sample-notes/runtimes/extract/RUNTIME.md",
    root.plugin,
  );
  const reader = parseRuntimeMd(
    `---\nschedule: {trigger: {type: manual}}\nfunction: {handler: ./handler.js}\nio: {inputs: {facts: {from: {runtime: ${runtimeId}}}}}\n---\n`,
    "/sample-notes/runtimes/read/RUNTIME.md",
    root.plugin,
  );
  expect(() =>
    validateRuntimeDeclarations(root, [producer, reader]),
  ).not.toThrow();
});

it("imports plugin helper examples from the author SDK", async () => {
  const text = await readFile(
    path.join(skillRoot, "references/plugin-testing.md"),
    "utf8",
  );
  const origin = text.match(
    /import \{ getPendingProposals \} from "([^"]+)"/,
  )?.[1];
  expect(origin).toBe("@covel/plugin-handlers-utils");
});
