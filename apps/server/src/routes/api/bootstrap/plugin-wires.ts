import {
  registerImageWire,
  registerMusicWire,
  registerSpeechWire,
  registerTranscriptionWire,
  type WireModuleShape,
} from "@covel/ai-provider";
import { PluginRegistrationError } from "./plugin-registration-error.js";

export type { WireModuleShape } from "@covel/ai-provider";

function hasWireShape(value: unknown, method: string): value is { id: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    (value as Record<string, unknown>).id !== "" &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}

/** Register entry-provided wires under the `<pluginId>/<wireId>` namespace. */
export function registerNamespaced(
  pluginId: string,
  mod: WireModuleShape,
  onRegistered: (dispose: () => void) => void = () => {},
  invoke: <T>(fn: () => T | Promise<T>) => Promise<T> = async (fn) => fn(),
): void {
  const groups: ReadonlyArray<{
    readonly wires: readonly { id: string }[] | undefined;
    readonly method: string;
    readonly register: (wire: never) => () => void;
  }> = [
    { wires: mod.image, method: "generate", register: registerImageWire },
    { wires: mod.speech, method: "synthesize", register: registerSpeechWire },
    {
      wires: mod.transcription,
      method: "transcribe",
      register: registerTranscriptionWire,
    },
    { wires: mod.music, method: "compose", register: registerMusicWire },
  ];

  for (const group of groups) {
    if (group.wires !== undefined && !Array.isArray(group.wires)) {
      throw new PluginRegistrationError(
        "registerWires",
        `${group.method} wires must be an array`,
      );
    }
    for (const wire of group.wires ?? []) {
      if (!hasWireShape(wire, group.method)) {
        throw new PluginRegistrationError(
          "registerWires",
          `expected { id: string, ${group.method}: function }`,
        );
      }
      const method = Reflect.get(wire, group.method) as (
        ...args: unknown[]
      ) => unknown;
      const namespaced = {
        ...wire,
        id: `${pluginId}/${wire.id}`,
        [group.method]: (...args: unknown[]) =>
          invoke(() => Reflect.apply(method, wire, args) as unknown),
      };
      try {
        onRegistered(group.register(namespaced as never));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already registered/.test(message)) {
          throw new PluginRegistrationError(
            "registerWires",
            `wire "${namespaced.id}" is already registered`,
          );
        }
        throw err;
      }
    }
  }
}
