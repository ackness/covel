import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "../src/index.js";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-runtime-paths-"));
  roots.push(parent);
  const root = path.join(parent, "probe");
  const write = async (file: string, value: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), value);
  };
  await write("package.json", '{"type":"module"}');
  await write(
    "PLUGIN.md",
    `---\nid: probe\nkind: plugin\ndescription: Path probe\ncontributes:\n  events:\n    - topic: probe.changed\n      schema: ./schema.json\n      description: A root event.\n---\n`,
  );
  await write("schema.json", '{"type":"string","const":"root"}');
  await write("schemas/input.json", '{"type":"integer","minimum":7}');
  await write(
    "runtimes/work/schema.json",
    '{"type":"string","const":"runtime"}',
  );
  await write(
    "runtimes/work/handler.js",
    'export default () => ({ output: "runtime" });',
  );
  await write("handler.js", 'throw new Error("wrong handler directory");');
  await write(
    "runtimes/work/RUNTIME.md",
    `---\nschedule: {trigger: {type: manual}}\nfunction: {handler: ./handler.js}\nio:\n  payloadSchema: ../../schemas/input.json\n  output: {schema: ./schema.json}\n---\n`,
  );
  await write(
    "runtimes/watch/RUNTIME.md",
    `---\nschedule: {trigger: {type: manual}}\nguard: ./guard.js\n---\nWatch.\n`,
  );
  await write(
    "runtimes/watch/guard.js",
    'export default () => ({ shouldRun: false, reason: "runtime" });',
  );
  await write("guard.js", 'throw new Error("wrong guard directory");');
  const discovery = (await discoverPlugins(parent))[0]!;
  return { parent, root, write, discovery };
}

it("loads runtime-private schemas and code at their declaration directory while root events keep their root schema", async () => {
  const f = await fixture();
  let errors = "";
  expect(
    await runValidateManifest([f.root], {
      stdout: { write: () => {} },
      stderr: {
        write: (s) => {
          errors += s;
        },
      },
    }),
    errors,
  ).toBe(0);
  const definition = await loadPluginDefinition(f.discovery);
  const loaded = await loadRuntime(
    f.discovery,
    "probe/work",
    "en-US",
    definition,
  );
  expect(loaded.outputSchema).toEqual({ type: "string", const: "runtime" });
  expect(loaded.inputSchema).toEqual({ type: "integer", minimum: 7 });
  expect(loaded.handler).toBeTypeOf("function");
  expect(
    (await loadRuntime(f.discovery, "probe/watch", "en-US", definition)).guard,
  ).toBeTypeOf("function");
  expect(
    definition.packageManifest.plugin.contributes?.events?.[0]?.schema,
  ).toBe("./schema.json");
});

it("does not read a conventional output schema outside the package through a symlink", async () => {
  const f = await fixture();
  await f.write("runtimes/watch/output.schema.json", '{"type":"string"}');
  const external = path.join(f.parent, "outside.json");
  await writeFile(external, '{"const":"outside"}');
  await rm(path.join(f.root, "runtimes/watch/output.schema.json"));
  await symlink(
    external,
    path.join(f.root, "runtimes/watch/output.schema.json"),
  );
  await expect(loadRuntime(f.discovery, "probe/watch")).rejects.toThrow(
    /path traversal|symlink/i,
  );
});

it("does not inherit a conventional schema from a parent repository", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.parent, "output.schema.json"),
    '{"const":"parent"}',
  );
  expect(
    (await loadRuntime(f.discovery, "probe/watch")).outputSchema,
  ).toBeUndefined();
});

it.each(["../../../outside.json", "/tmp/outside.json", "C:/outside.json"])(
  "rejects an escaping or absolute private schema: %s",
  async (schema) => {
    const f = await fixture();
    await f.write(
      "runtimes/work/RUNTIME.md",
      `---\nschedule: {trigger: {type: manual}}\nfunction: {handler: ./handler.js}\nio: {payloadSchema: ${JSON.stringify(schema)}}\n---\n`,
    );
    const status = await runValidateManifest([f.root], {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(status).toBe(1);
    await expect(loadRuntime(f.discovery, "probe/work")).rejects.toThrow(
      /invalid|traversal/i,
    );
  },
);
