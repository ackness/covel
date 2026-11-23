import {
  isModelFacingServiceContribution,
  serviceContributionAccess,
  serviceContributionContract,
  type PluginManifest,
} from "@covel/shared";
import type { PluginAPI } from "./plugin-api.js";

type Contributions = NonNullable<PluginManifest["contributes"]>;
/**
 * Appended to load errors where registrations and `contributes` disagree. A
 * plain string: the host never runs the command, authors do.
 */
export const REGISTRATION_SYNC_HINT =
  "Sync PLUGIN.md with the entry: pnpm plugin:extract <plugin-dir>";

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
  for (const id of declarations.appActions ?? []) declare("appAction", id);
  for (const id of declarations.flows ?? []) declare("flow", id);
  for (const event of declarations.appEvents ?? []) declare("appEvent", event);
  for (const schedule of declarations.schedules ?? [])
    declare("schedule", schedule.id);
  for (const source of declarations.providerSources ?? [])
    declare("providerSource", source.id);
  // Offering a service to models, and letting it write, are part of what is
  // declared: the markers make a registration that says otherwise a mismatch.
  const serviceKey = (
    contract: string,
    modelFacing: boolean,
    access: "read" | "write",
  ) => {
    const markers = [
      ...(modelFacing ? ["model-facing"] : []),
      ...(access === "write" ? ["write"] : []),
    ];
    return markers.length ? `${contract} (${markers.join(", ")})` : contract;
  };
  for (const entry of declarations.services ?? [])
    declare(
      "service",
      serviceKey(
        serviceContributionContract(entry),
        isModelFacingServiceContribution(entry),
        serviceContributionAccess(entry),
      ),
    );
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
    const allowed = expected.get(key) ?? 0;
    if (count > allowed)
      throw invalid(
        `Undeclared or duplicate registration: ${key}${allowed === 0 ? `. ${REGISTRATION_SYNC_HINT}` : ""}`,
      );
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
      registerAppAction(action, handler, options) {
        api.registerAppAction(action, handler, options);
        record("appAction", action);
      },
      registerConfigFlow(flowId, definition) {
        api.registerConfigFlow(flowId, definition);
        record("flow", flowId);
      },
      onAppEvent(event, handler) {
        api.onAppEvent(event, handler);
        record("appEvent", event);
      },
      registerScheduledTask(taskId, handler) {
        api.registerScheduledTask(taskId, handler);
        record("schedule", taskId);
      },
      registerService(definition) {
        if (!definition || typeof definition !== "object")
          throw invalid("Invalid service definition");
        api.registerService(definition);
        record(
          "service",
          serviceKey(
            definition.contract,
            definition.modelFacing === true,
            definition.access === "write" ? "write" : "read",
          ),
        );
      },
      registerFormValidator(name, validator) {
        api.registerFormValidator(name, validator);
        record("form", name);
      },
      on(event, handler, options) {
        api.on(event, handler, options);
        const key = `${event}:${options?.enforce ?? "normal"}`;
        if (!expectedHooks.has(key))
          throw invalid(
            `Undeclared registration: hook:${key}. ${REGISTRATION_SYNC_HINT}`,
          );
        seenHooks.add(key);
      },
      registerWires(wires) {
        if (!wires || typeof wires !== "object")
          throw invalid("Invalid wire module");
        const groups = [
          wires.text,
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
      registerProviderSources(sources) {
        if (!Array.isArray(sources))
          throw invalid("Invalid provider sources list");
        for (const source of sources) {
          if (
            !source ||
            typeof source !== "object" ||
            typeof source.id !== "string" ||
            !source.id ||
            typeof source.resolve !== "function"
          ) {
            throw invalid("Invalid provider source definition");
          }
        }
        api.registerProviderSources(sources);
        for (const source of sources) record("providerSource", source.id);
      },
    },
    validate() {
      for (const key of expectedHooks) {
        if (!seenHooks.has(key))
          throw invalid(
            `Missing registration: hook:${key}. ${REGISTRATION_SYNC_HINT}`,
          );
      }
      for (const [key, count] of expected) {
        if (seen.get(key) !== count)
          throw invalid(
            `Missing registration: ${key}. ${REGISTRATION_SYNC_HINT}`,
          );
      }
      for (const command of declarations.commands ?? []) {
        if (
          command.action !== undefined &&
          !declarations.actions?.includes(command.action)
        )
          throw invalid(
            `Command "${command.name}" references undeclared action "${command.action}"`,
          );
        if (
          command.appAction !== undefined &&
          !declarations.appActions?.includes(command.appAction)
        )
          throw invalid(
            `Command "${command.name}" references undeclared appAction "${command.appAction}"`,
          );
        if (
          command.openFlow !== undefined &&
          !declarations.flows?.includes(command.openFlow)
        )
          throw invalid(
            `Command "${command.name}" references undeclared openFlow "${command.openFlow}"`,
          );
      }
    },
  };
}
