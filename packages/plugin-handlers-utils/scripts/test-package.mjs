/** Pack, import, and typecheck the actual artifact outside the workspace. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rename,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "covel-helper-package-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", temp], {
    cwd: root,
    stdio: "pipe",
  });
  const archive = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
  assert.ok(archive);
  execFileSync("tar", ["-xzf", path.join(temp, archive), "-C", temp]);
  const target = path.join(temp, "node_modules/@covel/plugin-handlers-utils");
  await mkdir(path.dirname(target), { recursive: true });
  await rename(path.join(temp, "package"), target);
  const manifest = JSON.parse(
    await readFile(path.join(target, "package.json"), "utf8"),
  );
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies, { zod: "^4.4.3" });
  // Zod is a public peer. Resolve it from the SDK package and place only
  // that peer beside the packed artifact; no private workspace package is
  // visible to the consumer.
  await symlink(
    path.dirname(require.resolve("zod/package.json")),
    path.join(temp, "node_modules/zod"),
    "dir",
  );
  await writeFile(
    path.join(temp, "consumer.mjs"),
    `
import assert from "node:assert/strict";
import { makeProposal, optionalNumber, pickLocaleText, createNarrativeReview } from "@covel/plugin-handlers-utils";
import { runImageGeneration } from "@covel/plugin-handlers-utils/image-generation";
assert.equal(optionalNumber("42"), 42);
assert.equal(pickLocaleText("ZH_cn", "zh", "en"), "zh");
assert.equal(makeProposal({ pluginId: "sample", turnId: "t", sessionId: "s" }, "now", "plugin.data", { namespace: "notes", key: "current", value: 1 }).type, "plugin.data");
assert.equal(typeof createNarrativeReview("sample").review, "function");
assert.equal(typeof runImageGeneration, "function");
`,
  );
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: temp,
    stdio: "pipe",
  });
  await writeFile(
    path.join(temp, "consumer.mts"),
    `
import { makeProposal, optionalNumber } from "@covel/plugin-handlers-utils";
import type { ImageGenerationHandlerContext } from "@covel/plugin-handlers-utils/image-generation";
import type { PluginAPI, PluginEntryFactory } from "@covel/plugin-handlers-utils";
const p = makeProposal({pluginId:"sample",turnId:"t",sessionId:"s"},"now","plugin.data",{namespace:"notes",key:"current",value:1});
const kind: "plugin.data" = p.type;
const value: number = p.payload.value;
const ctx: ImageGenerationHandlerContext = {turnId:"t"};
declare const api: PluginAPI;
api.provideExtension("prompt.segment@1", "note", {handler: (input) => {
  const t: string = input.turnId;
  void t;
  return [{id: "s", content: "c", position: "system", audience: "all", volatility: "turn"}];
}});
api.provideExtension("history.compact@1", "summary", {handler: async (_input, context) => {
  const response = await context.gateway?.generateText({prompt: "Summarize the history"});
  const verdict = context.utils?.validateBaseUrl("https://example.com");
  const request = context.utils?.fetchWithRetry("https://example.com");
  const geography = context.world.worldRecord?.dimensions?.geography?.regions;
  const opening = context.world.worldRecord?.dimensions?.startingConditions?.openingHook;
  void [verdict, request, geography, opening];
  return {messageIds: [], content: response?.text ?? "", focusSections: []};
}});
const entry: PluginEntryFactory = (covel) => {
  covel.registerTool(covel.toolkit.tool({
    name: "echo",
    description: "Echo text",
    parameters: covel.toolkit.z.object({ text: covel.toolkit.z.string() }),
    execute: async ({ text }, context) => {
      const sessionId: string = context.sessionId;
      return { text, sessionId };
    },
  }));
  covel.on("TurnStart", async (context) => {
    const id: string = context.sessionId;
    void id;
    return { action: "continue" };
  });
  covel.registerRpc("echo", async (payload, context) => {
    const sessionId: string = context.sessionId;
    return { payload, sessionId };
  });
  covel.registerService({
    name: "echo",
    contract: "sample/echo@1",
    input: covel.toolkit.z.object({ text: covel.toolkit.z.string() }),
    output: covel.toolkit.z.object({ text: covel.toolkit.z.string() }),
    handler: (input) => ({ text: input.text }),
  });
  covel.registerWires({ image: [] });
  covel.registerFormValidator("sample", (values) =>
    values.text === undefined ? "text is required" : undefined,
  );
  covel.onDispose(async () => {});
  covel.http.validateBaseUrl("https://example.com");
};
// @ts-expect-error Unknown extension point ids are rejected.
api.provideExtension("unknown.point@1", "bad", { handler: () => null });
// @ts-expect-error Wrong handler output for a known point is rejected.
api.provideExtension("prompt.segment@1", "bad", { handler: () => 1 });
void [kind,value,ctx,entry,optionalNumber("1")];
`,
  );
  await writeFile(
    path.join(temp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: false,
      },
      files: ["consumer.mts"],
    }),
  );
  execFileSync(
    process.execPath,
    [
      path.join(
        path.dirname(require.resolve("typescript/package.json")),
        "bin/tsc",
      ),
      "-p",
      path.join(temp, "tsconfig.json"),
    ],
    { cwd: temp, stdio: "pipe" },
  );
  console.log(
    "Packaged SDK imports and typechecks without workspace dependencies.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
