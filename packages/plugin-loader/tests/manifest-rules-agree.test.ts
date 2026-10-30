/**
 * One copy of the declarative manifest rules: loading, `pnpm validate:plugin`
 * and the parsers installation uses reach the same verdict, name the file and
 * the field the author wrote. A runtime that can never run is left out at load
 * while the rest of its package works.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import {
  discoverPluginAt,
  loadPluginDefinition,
  loadPluginUiSpecs,
  parsePluginMd,
  parseRuntimeMd,
  validatePluginFiles,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeManifest(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\n${JSON.stringify(value)}\n---\nPrompt.\n`);
}

async function plugin(
  root: Record<string, unknown>,
  runtimes: Record<string, unknown> = {},
  files: Record<string, string> = {},
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-rules-"));
  roots.push(temp);
  const dir = path.join(temp, "probe");
  await writeManifest(path.join(dir, "PLUGIN.md"), {
    id: "probe",
    kind: "plugin",
    description: "Probe",
    ...root,
  });
  await writeFile(
    path.join(dir, "handler.js"),
    "export default () => ({ outcome: 'success' });",
  );
  for (const [id, runtime] of Object.entries(runtimes))
    await writeManifest(path.join(dir, "runtimes", id, "RUNTIME.md"), runtime);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

async function validate(dir: string) {
  let stderr = "";
  const status = await runValidateManifest([dir], {
    stdout: { write: () => true },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stderr };
}

async function load(dir: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return loadPluginDefinition((await discoverPluginAt(dir))!);
}

const staged = {
  function: { handler: "../../handler.js" },
  schedule: { stage: "narrative" },
};

/** Each runtime here can never run; nothing else in its package depends on it. */
const unrunnable = [
  {
    name: "an auto runtime without a stage",
    runtime: { io: { output: { contract: "notes@1" } } },
    field: "schedule.stage",
  },
  {
    name: "an auto runtime with a cadence and no stage",
    runtime: {
      schedule: { every: 3 },
      io: { output: { contract: "notes@1" } },
    },
    field: "schedule.stage",
  },
  {
    name: "a background manual runtime with a same-execution input",
    runtime: {
      function: { handler: "../../handler.js" },
      schedule: { trigger: { type: "manual" }, background: true },
      io: {
        inputs: { prose: { from: { runtime: "probe/good" } } },
        output: { contract: "notes@1" },
      },
    },
    field: "io.inputs.prose",
  },
];

describe("a runtime that can never run", () => {
  it.each(unrunnable)(
    "$name: loading leaves it out, validation and installation reject it",
    async ({ runtime, field }) => {
      const dir = await plugin(
        {},
        {
          bad: runtime,
          good: staged,
        },
      );
      const file = path.join(dir, "runtimes/bad/RUNTIME.md");

      const definition = await load(dir);
      expect(definition.manifests.map(({ manifest }) => manifest.name)).toEqual(
        ["probe/good"],
      );
      expect(definition.disabledRuntimes).toHaveLength(1);
      expect(definition.disabledRuntimes[0]!.message).toContain(
        `${file}: ${field}:`,
      );
      // Nothing may count on what the left-out runtime would have provided.
      expect(definition.packageManifest.plugin.provides).toBeUndefined();

      const result = await validate(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}: ${field}:`);

      const root = parsePluginMd(
        await readFile(path.join(dir, "PLUGIN.md"), "utf8"),
        path.join(dir, "PLUGIN.md"),
      );
      expect(() =>
        parseRuntimeMd(
          `---\n${JSON.stringify(runtime)}\n---\n`,
          file,
          root.plugin,
        ),
      ).toThrow(`${file}: ${field}:`);
    },
  );

  it("leaves out an inline runtime and keeps the package", async () => {
    // A written default-provider entry goes too.
    const dir = await plugin({
      provides: [{ contract: "notes@1", default: true }],
      runtime: { io: { output: { contract: "notes@1" } } },
    });
    const file = path.join(dir, "PLUGIN.md");

    const definition = await load(dir);
    expect(definition.manifests).toEqual([]);
    expect(definition.disabledRuntimes[0]!.message).toContain(
      `${file}: runtime.schedule.stage:`,
    );
    expect(definition.packageManifest.plugin.provides).toBeUndefined();

    const result = await validate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}: runtime.schedule.stage:`);

    // Installation parses the root, then checks the files.
    const root = parsePluginMd(await readFile(file, "utf8"), file);
    expect(() => validatePluginFiles(root, [], () => "")).toThrow(
      `${file}: runtime.schedule.stage:`,
    );
  });

  it("does not leave out a runtime with another problem", async () => {
    const dir = await plugin(
      {},
      {
        bad: { schedule: { stage: "pre-turn", extra: true } },
      },
    );
    await expect(load(dir)).rejects.toThrow("schedule");
  });
});

/** Rules every entry checks on what the author wrote, under the author's names. */
const crossField = [
  {
    name: "a background manual agent with suspend",
    runtime: {
      schedule: { trigger: { type: "manual" }, background: true },
      agent: { tools: { builtin: ["suspend"] } },
    },
    field: "agent.tools.builtin",
  },
  {
    name: "a detached function with suspend",
    runtime: {
      schedule: { stage: "post-turn", detached: true },
      function: {
        handler: "../../handler.js",
        tools: { builtin: ["suspend"] },
      },
    },
    field: "function.tools.builtin",
  },
  {
    name: "a stage on an event runtime",
    runtime: {
      schedule: {
        stage: "narrative",
        trigger: { type: "event", topic: "x.y" },
      },
    },
    field: "schedule.stage",
  },
  {
    name: "detached completion on the narrative stage",
    runtime: {
      schedule: { stage: "narrative", detached: true },
    },
    field: "schedule.stage",
  },
  {
    name: "detached completion on a story runtime",
    runtime: {
      schedule: { stage: "post-turn", detached: { maxQueueMs: 1000 } },
      io: { visibility: "story" },
    },
    field: "io.visibility",
  },
  {
    name: "explicit completion on a story runtime",
    runtime: {
      schedule: { stage: "narrative" },
      io: { visibility: "story" },
      agent: { completion: { require: "explicit" } },
    },
    field: "agent.completion.require",
  },
  {
    name: "recordAs without an output schema",
    runtime: {
      schedule: { stage: "narrative" },
      io: { output: { recordAs: "latest" } },
    },
    field: "io.output.schema",
  },
  {
    name: "a session-scoped need outside setup",
    runtime: {
      schedule: {
        stage: "narrative",
        needs: [{ runtime: "probe/other", scope: "session" }],
      },
    },
    field: "schedule.needs.0.scope",
  },
  {
    name: "an event trigger without a topic",
    runtime: { schedule: { trigger: { type: "event" } } },
    field: "schedule.trigger.topic",
  },
  {
    name: "a settle wait without settle",
    runtime: {
      schedule: { stage: "post-turn", detached: { maxSettleWaitMs: 1000 } },
    },
    field: "schedule.detached.maxSettleWaitMs",
  },
  {
    name: "an imported service named like a framework tool",
    runtime: {
      schedule: { stage: "narrative" },
      agent: {
        tools: { services: [{ contract: "inventory.items@1", as: "suspend" }] },
      },
    },
    field: "agent.tools.services.0.as",
  },
  {
    name: "an imported service that completes the run",
    runtime: {
      schedule: { stage: "post-turn" },
      agent: {
        tools: { services: ["inventory.items@1"] },
        finishWith: "inventory-items",
      },
    },
    field: "agent.finishWith",
  },
  {
    name: "finishWith beside the long completion form",
    runtime: {
      schedule: { stage: "post-turn" },
      agent: {
        finishWith: "save",
        completion: { require: "tool-use", afterTools: ["save"] },
      },
    },
    field: "agent.finishWith",
  },
  {
    name: "a story runtime with a required contract input",
    runtime: {
      ...staged,
      io: {
        visibility: "story",
        inputs: { cast: { from: { contract: "scene-cast@1" } } },
      },
    },
    field: "io.inputs.cast.required",
  },
  {
    name: "a story runtime that needs a contract",
    runtime: {
      ...staged,
      schedule: { stage: "narrative", needs: [{ contract: "scene-cast@1" }] },
      io: { visibility: "story" },
    },
    field: "schedule.needs.0",
  },
  {
    name: "options on a kernel input",
    runtime: {
      schedule: { stage: "narrative" },
      io: {
        inputs: {
          digest: { from: { kernel: "turn-digest@1" }, required: false },
        },
      },
    },
    field: "io.inputs.digest.required",
  },
];

describe("cross-field rules", () => {
  it.each(crossField)(
    "$name: the inline runtime error names PLUGIN.md and the author field",
    async ({ runtime, field }) => {
      const dir = await plugin({ runtime: { ...runtime } });
      const file = path.join(dir, "PLUGIN.md");
      const error = await load(dir).then(
        () => undefined,
        (caught: Error) => caught.message,
      );
      expect(error).toContain(`${file}: runtime.${field}:`);
      expect(error).not.toMatch(/turnCompletion|outputKind|requireExplicit/);
      expect((await validate(dir)).stderr).toContain(
        `${file}: runtime.${field}:`,
      );
    },
  );

  it.each(crossField)(
    "$name: the RUNTIME.md error names its file and the author field",
    async ({ runtime, field }) => {
      const dir = await plugin(
        {},
        {
          one: { ...runtime },
        },
      );
      const file = path.join(dir, "runtimes/one/RUNTIME.md");
      const error = await load(dir).then(
        () => undefined,
        (caught: Error) => caught.message,
      );
      expect(error).toContain(`${file}: ${field}:`);
      expect(error).not.toMatch(/turnCompletion|outputKind|requireExplicit/);
    },
  );

  it("rejects a story package that requires a plugin contract, and accepts a system one", async () => {
    const storyRuntime = { ...staged, io: { visibility: "story" } };
    const story = await plugin(
      { requires: ["scene-cast@1"] },
      { one: storyRuntime },
    );
    const file = path.join(story, "PLUGIN.md");
    const error = await load(story).then(
      () => undefined,
      (caught: Error) => caught.message,
    );
    expect(error).toContain(`${file}: requires:`);
    expect(error).toContain("cannot require contract scene-cast@1");
    expect((await validate(story)).stderr).toContain(`${file}: requires:`);

    const inlineRuntime = {
      ...storyRuntime,
      function: { handler: "./handler.js" },
    };
    const inline = await plugin({
      requires: ["scene-cast@1"],
      runtime: inlineRuntime,
    });
    const inlineResult = await validate(inline);
    expect(inlineResult.status).toBe(1);
    expect(inlineResult.stderr).toContain(
      `${path.join(inline, "PLUGIN.md")}: requires:`,
    );
    expect(inlineResult.stderr).toContain(
      "cannot require contract scene-cast@1",
    );
    const inlineControl = await plugin({ runtime: inlineRuntime });
    expect((await validate(inlineControl)).status).toBe(0);

    const system = await plugin(
      { requires: ["scene-cast@1"] },
      { one: staged },
    );
    expect((await validate(system)).status).toBe(0);
    const kernel = await plugin(
      { requires: ["stage.cast@1"] },
      { one: storyRuntime },
    );
    expect((await validate(kernel)).status).toBe(0);
  });

  it("accepts a kernel input that names only its source", async () => {
    const dir = await plugin(
      {},
      {
        one: {
          schedule: { stage: "post-turn" },
          io: { inputs: { digest: { from: { kernel: "turn-digest@1" } } } },
        },
      },
    );
    expect((await validate(dir)).status).toBe(0);
  });

  it("orders after a contract the package does not depend on", async () => {
    const dir = await plugin(
      {},
      {
        one: {
          ...staged,
          schedule: { stage: "narrative", after: [{ contract: "story@1" }] },
        },
      },
    );
    expect((await validate(dir)).status).toBe(0);
  });
});

/** UI specs: what validation passes, the game shows; what it rejects, the game does not. */
const uiSpecs: {
  name: string;
  spec: unknown;
  files?: Record<string, string>;
}[] = [
  {
    name: "another plugin's binding",
    spec: { view: { component: "Text", props: { pluginId: "other" } } },
  },
  {
    name: "a newer specVersion",
    spec: { specVersion: 2, view: { component: "Text" } },
  },
  {
    name: "a webview entry that is not .html",
    spec: { webview: { entry: "./panel.htm" } },
    files: { "ui/panel.htm": "<p>hi</p>" },
  },
  {
    name: "a webview taller than allowed",
    spec: { webview: { entry: "./panel.html", height: 1200 } },
    files: { "ui/panel.html": "<p>hi</p>" },
  },
  {
    name: "a missing webview document",
    spec: { webview: { entry: "./missing.html" } },
  },
  {
    name: "an unknown surface",
    spec: { surfaces: ["sidebar"], view: { component: "Text" } },
  },
  {
    name: "a relative repeat path",
    spec: {
      view: { component: "Stack", repeat: { statePath: "entries" } },
    },
  },
  {
    name: "an item path with a slash",
    spec: {
      view: { component: "Text", props: { content: { $item: "/name" } } },
    },
  },
  { name: "an unknown component", spec: { view: { component: "Widget" } } },
];

describe("dataset declarations", () => {
  it("a key that is not a required schema property is rejected by load and validation alike", async () => {
    const dir = await plugin(
      {
        contributes: {
          datasets: { journal: { schema: "./journal.json", key: "ghost" } },
        },
      },
      {},
      {
        "journal.json": JSON.stringify({
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        }),
      },
    );
    const message = `${path.join(dir, "PLUGIN.md")}: contributes.datasets.journal.key: ghost is not a required property of ./journal.json`;
    await expect(load(dir)).rejects.toThrow(message);
    const result = await validate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe("UI specs", () => {
  async function uiPlugin(spec: unknown, files: Record<string, string> = {}) {
    return plugin(
      {
        contributes: { ui: { right: ["./ui/panel.json"] } },
      },
      {},
      { "ui/panel.json": JSON.stringify(spec), ...files },
    );
  }

  it.each(uiSpecs)(
    "$name: validation rejects it and the game reports it",
    async ({ spec, files }) => {
      const dir = await uiPlugin(spec, files);
      const result = await validate(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ui/panel.json");

      const loaded = await loadPluginUiSpecs(dir, "probe", {
        right: ["./ui/panel.json"],
      });
      expect(loaded.slots).toEqual({});
      expect(loaded.diagnostics).toHaveLength(1);
    },
  );

  it("a valid spec passes validation and loads", async () => {
    const dir = await uiPlugin(
      {
        webview: { entry: "./panel.html", height: 300 },
        surfaces: ["stage"],
      },
      { "ui/panel.html": "<p>hi</p>" },
    );
    expect((await validate(dir)).status).toBe(0);
    const loaded = await loadPluginUiSpecs(dir, "probe", {
      right: ["./ui/panel.json"],
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.slots.right?.[0]).toMatchObject({
      webview: { html: "<p>hi</p>", height: 300 },
    });
  });

  it("one rejected spec leaves the package's other panels", async () => {
    const dir = await plugin(
      {},
      {},
      {
        "ui/good.json": JSON.stringify({ view: { component: "Text" } }),
        "ui/bad.json": JSON.stringify({ view: { component: "Widget" } }),
      },
    );
    const loaded = await loadPluginUiSpecs(dir, "probe", {
      right: ["./ui/bad.json", "./ui/good.json"],
      message: ["./ui/panel.tsx"],
    });
    expect(loaded.slots.right).toHaveLength(1);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ slot: "right", specIndex: 0 }),
      expect.objectContaining({ slot: "message", specIndex: 0 }),
    ]);
  });
});
