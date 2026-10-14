import {
  registerImageWire,
  registerMusicWire,
  registerSpeechWire,
  registerTextWire,
  registerTranscriptionWire,
  WireAlreadyRegisteredError,
  type TextWire,
  type WireOwner,
  type WireModuleShape,
} from "@covel/ai-provider";
import { withWireEndpoint } from "./entry-http.js";
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

/**
 * Register entry-provided wires under the `<pluginId>/<wireId>` namespace.
 * Every wire carries its plugin as owner, so it serves only sessions in which
 * that plugin is active. Each call runs with the slot's endpoint, which the
 * package's `covel.http` may reach without declaring it.
 */
export function registerNamespaced(
  pluginId: string,
  mod: WireModuleShape,
  onRegistered: (dispose: () => void) => void = () => {},
  invoke: <T>(fn: () => T | Promise<T>) => Promise<T> = async (fn) => fn(),
  builtin = false,
): void {
  const owner: WireOwner = { pluginId, builtin };
  // The first argument of every wire method is the slot's resolved config.
  const call = <T>(args: readonly unknown[], fn: () => T | Promise<T>) =>
    invoke(() => withWireEndpoint(pluginId, args[0], fn));
  const groups: ReadonlyArray<{
    readonly wires: readonly { id: string }[] | undefined;
    readonly method: string;
    readonly register: (wire: never, owner: WireOwner) => () => void;
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
      if (err instanceof WireAlreadyRegisteredError) {
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
    register(id, () =>
      registerTextWire(namespacedTextWire(id, wire, pluginId, call), owner),
    );
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
          call(args, () => Reflect.apply(method, wire, args) as unknown),
      };
      register(namespaced.id, () => group.register(namespaced as never, owner));
    }
  }
}

/**
 * Every call into the plugin goes through `call`, each step of a stream too:
 * a stream's body runs in the step that pulls it, not where it was created.
 */
function namespacedTextWire(
  id: string,
  wire: TextWire,
  pluginId: string,
  call: <T>(args: readonly unknown[], fn: () => T | Promise<T>) => Promise<T>,
): TextWire {
  const { generateObject, listModels } = wire;
  return {
    ...wire,
    id,
    generateText: (...args) => call(args, () => wire.generateText(...args)),
    async *streamText(...args) {
      const stream = await call(args, () => wire.streamText(...args));
      const iterator = stream[Symbol.asyncIterator]();
      let done = false;
      try {
        for (;;) {
          const step = await call(args, () => iterator.next());
          if (step.done) {
            done = true;
            return;
          }
          yield step.value;
        }
      } finally {
        if (!done)
          await withWireEndpoint(pluginId, args[0], () => iterator.return?.());
      }
    },
    ...(typeof generateObject === "function"
      ? {
          generateObject: (...args) =>
            call(args, () => Reflect.apply(generateObject, wire, args)),
        }
      : {}),
    ...(typeof listModels === "function"
      ? {
          listModels: (...args) =>
            call(args, () => Reflect.apply(listModels, wire, args)),
        }
      : {}),
  };
}
