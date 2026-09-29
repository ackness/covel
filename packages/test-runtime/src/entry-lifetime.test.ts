import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadPluginDefinition } from "@covel/plugin-loader";
import { PluginServiceRegistry } from "@covel/runtime";
import { loadEntryTools } from "./runtime-loading.js";

it.each(["tool", "service"])(
  "keeps entry resources until an active %s callback settles",
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "covel-entry-retain-"));
    let entry: Awaited<ReturnType<typeof loadEntryTools>> | undefined;
    let release: (() => void) | undefined;
    try {
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(root, "PLUGIN.md"),
        `---\nid: probe\nkind: plugin\ndescription: Probe\nentry: ./entry.js\ncontributes: {tools: [wait], services: [test.wait@1]}\n---\n`,
      );
      const entryPath = path.join(root, "entry.js");
      await writeFile(
        entryPath,
        `
      export const state = {disposed:false,finished:false,aborted:false};
      let begin, finish;
      export const started = new Promise(resolve => {begin=resolve;});
      const work = new Promise(resolve => {finish=resolve;});
      export function release() {finish();}
      export default covel => {
        covel.signal.addEventListener("abort",()=>{state.aborted=true;},{once:true});
        covel.onDispose(()=>{state.disposed=true;});
        const handler = async () => {begin(); await work; if (state.disposed) throw new Error("resource already disposed"); state.finished=true; return {};};
        covel.registerTool(covel.toolkit.tool({name:"wait",description:"Wait",parameters:covel.toolkit.z.object({}),execute:handler}));
        covel.registerService({name:"wait",contract:"test.wait@1",input:covel.toolkit.z.object({}),output:covel.toolkit.z.object({}),handler});
      };
    `,
      );
      const stateModule = (await import(
        pathToFileURL(await realpath(entryPath)).href
      )) as {
        state: { disposed: boolean; finished: boolean; aborted: boolean };
        started: Promise<void>;
        release(): void;
      };
      release = stateModule.release;
      const discovery = {
        id: "probe",
        rootPath: root,
        isMultiRuntime: false,
        pluginMdPaths: [path.join(root, "PLUGIN.md")],
      };
      const services = new PluginServiceRegistry({
        list: async () => ["probe"],
        ensure: async () => {},
      });
      entry = await loadEntryTools(
        discovery,
        await loadPluginDefinition(discovery),
        services,
      );
      const pending =
        kind === "tool"
          ? entry.tools[0]!.execute(
              {},
              {
                sessionId: "s",
                turnId: "t",
                pluginId: "probe",
                runtimeId: "probe",
              },
            )
          : services
              .createClient({
                sessionId: "s",
                pluginId: "probe",
                signal: new AbortController().signal,
              })
              .call({
                pluginId: "probe",
                name: "wait",
                contract: "test.wait@1",
                input: {},
              });
      await stateModule.started;
      const closing = entry.close();
      expect(stateModule.state).toEqual({
        disposed: false,
        finished: false,
        aborted: true,
      });
      release();
      await pending;
      await closing;
      expect(stateModule.state).toEqual({
        disposed: true,
        finished: true,
        aborted: true,
      });
    } finally {
      release?.();
      await entry?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
