import {
  registerImageWire,
  registerMusicWire,
  registerSpeechWire,
  registerTextWire,
  registerTranscriptionWire,
  type TextWire,
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

  const register = (id: string, registration: () => () => void): void => {
    try {
      onRegistered(registration());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already registered/.test(message)) {
        throw new PluginRegistrationError(
          "registerWires",
          `wire "${id}" is already registered`,
        );
      }
      throw err;
    }
  };

  if (mod.text !== undefined && !Array.isArray(mod.text)) {
    throw new PluginRegistrationError(
      "registerWires",
      "text wires must be an array",
    );
  }
  for (const wire of mod.text ?? []) {
    const candidate: unknown = wire;
    if (
      !hasWireShape(candidate, "generateText") ||
      typeof Reflect.get(candidate, "streamText") !== "function"
    ) {
      throw new PluginRegistrationError(
        "registerWires",
        "expected { id: string, generateText: function, streamText: function }",
      );
    }
    const id = `${pluginId}/${wire.id}`;
    register(id, () => registerTextWire(namespacedTextWire(id, wire, invoke)));
  }

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
      register(namespaced.id, () => group.register(namespaced as never));
    }
  }
}

/** Every call into the plugin goes through `invoke`, a stream's start too. */
function namespacedTextWire(
  id: string,
  wire: TextWire,
  invoke: <T>(fn: () => T | Promise<T>) => Promise<T>,
): TextWire {
  const { generateObject, listModels } = wire;
  return {
    ...wire,
    id,
    generateText: (...args) => invoke(() => wire.generateText(...args)),
    async *streamText(...args) {
      yield* await invoke(() => wire.streamText(...args));
    },
    ...(typeof generateObject === "function"
      ? {
          generateObject: (...args) =>
            invoke(() => Reflect.apply(generateObject, wire, args)),
        }
      : {}),
    ...(typeof listModels === "function"
      ? {
          listModels: (...args) =>
            invoke(() => Reflect.apply(listModels, wire, args)),
        }
      : {}),
  };
}
