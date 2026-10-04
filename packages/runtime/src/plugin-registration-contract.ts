import type { PluginManifest } from "@covel/shared";
import type { PluginAPI } from "./plugin-api.js";

type Contributions = NonNullable<PluginManifest["contributes"]>;
/** Verify the declaration boundary before the staged batch becomes visible. */
export function enforcePluginRegistrationContract(
  api: PluginAPI,
  declarations: Contributions,
  invalid: (message: string) => Error = (message) => new Error(message),
): { api: PluginAPI; validate(): void } {
  const expected = new Map<string, number>();
  const seen = new Map<string, number>();
  const declare = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  };
  for (const id of declarations.tools ?? []) declare("tool", id);
  for (const id of declarations.actions ?? []) declare("action", id);
  for (const id of declarations.services ?? []) declare("service", id);
  for (const id of declarations.forms ?? []) declare("form", id);
  for (const id of declarations.wires ?? []) declare("wire", id);
  // Hooks declare event/phase access, not a handler count. Multiple independent
  // handlers may implement the same declared event and phase.
  const expectedHooks = new Set(
    (declarations.hooks ?? []).map(
      (hook) => `${hook.event}:${hook.enforce ?? "normal"}`,
    ),
  );
  const seenHooks = new Set<string>();
  const record = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    const count = (seen.get(key) ?? 0) + 1;
    if (count > (expected.get(key) ?? 0))
      throw invalid(`Undeclared or duplicate registration: ${key}`);
    seen.set(key, count);
  };
  return {
    // Builders validate and stage first; declaration failures still discard the
    // whole unpublished scope, while malformed inputs keep precise diagnostics.
    api: {
      ...api,
      registerTool(tool) {
        if (!tool || typeof tool !== "object")
          throw invalid("Invalid tool definition");
        api.registerTool(tool);
        record("tool", tool.name);
      },
      registerRpc(action, handler, options) {
        api.registerRpc(action, handler, options);
        record("action", action);
      },
      registerService(definition) {
        if (!definition || typeof definition !== "object")
          throw invalid("Invalid service definition");
        api.registerService(definition);
        record("service", definition.contract);
      },
      registerFormValidator(name, validator) {
        api.registerFormValidator(name, validator);
        record("form", name);
      },
      on(event, handler, options) {
        api.on(event, handler, options);
        const key = `${event}:${options?.enforce ?? "normal"}`;
        if (!expectedHooks.has(key))
          throw invalid(`Undeclared registration: hook:${key}`);
        seenHooks.add(key);
      },
      registerWires(wires) {
        if (!wires || typeof wires !== "object")
          throw invalid("Invalid wire module");
        const groups = [
          wires.image,
          wires.speech,
          wires.transcription,
          wires.music,
        ];
        for (const group of groups) {
          if (
            group !== undefined &&
            (!Array.isArray(group) ||
              group.some((wire) => !wire || typeof wire !== "object"))
          )
            throw invalid("Invalid wire group");
        }
        api.registerWires(wires);
        for (const group of groups) {
          for (const wire of group ?? []) record("wire", wire.id);
        }
      },
    },
    validate() {
      for (const key of expectedHooks) {
        if (!seenHooks.has(key))
          throw invalid(`Missing registration: hook:${key}`);
      }
      for (const [key, count] of expected) {
        if (seen.get(key) !== count)
          throw invalid(`Missing registration: ${key}`);
      }
      for (const command of declarations.commands ?? []) {
        if (!declarations.actions?.includes(command.action))
          throw invalid(
            `Command "${command.name}" references undeclared action "${command.action}"`,
          );
      }
    },
  };
}
