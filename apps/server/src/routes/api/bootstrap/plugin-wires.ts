import {
  registerImageWire,
  registerSpeechWire,
  registerTranscriptionWire,
  type WireModuleShape,
} from "@covel/ai-provider";

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
  pluginRelPath: string,
  mod: WireModuleShape,
): void {
  const groups: ReadonlyArray<{
    readonly wires: readonly { id: string }[] | undefined;
    readonly method: string;
    readonly register: (wire: never) => void;
  }> = [
    { wires: mod.image, method: "generate", register: registerImageWire },
    { wires: mod.speech, method: "synthesize", register: registerSpeechWire },
    {
      wires: mod.transcription,
      method: "transcribe",
      register: registerTranscriptionWire,
    },
  ];

  for (const group of groups) {
    for (const wire of group.wires ?? []) {
      if (!hasWireShape(wire, group.method)) {
        console.warn(
          `[plugin-wires] ${pluginRelPath}: skipping malformed wire entry — expected { id: string, ${group.method}: fn }`,
        );
        continue;
      }
      const namespaced = { ...wire, id: `${pluginId}/${wire.id}` };
      try {
        group.register(namespaced as never);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already registered/.test(message)) {
          console.warn(
            `[plugin-wires] ${pluginRelPath}: wire "${namespaced.id}" already registered — skipping`,
          );
          continue;
        }
        throw err;
      }
    }
  }
}
