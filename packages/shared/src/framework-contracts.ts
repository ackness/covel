/**
 * Contracts whose schema the framework owns.
 *
 * A plugin provides or consumes these contracts like any other, but no
 * package publishes their schema: the loader supplies it, and a package that
 * declares one of them with a different schema is refused. Owning the schema
 * does not make a provider required, and only `kernel` contracts are read by
 * the kernel itself.
 *
 * `providers: "single"` means a session admits one provider package of the
 * contract. Plugin selection derives the conflict from it, as for a `single`
 * extension point, so providers do not write `conflicts` for it.
 */
import {
  CHARACTER_ACTOR_CONTRACT,
  characterActorOutputJsonSchema,
  storyOutputJsonSchema,
} from "@covel/plugin-handlers-utils";
import { STORY_OUTPUT_CONTRACT } from "./extension-points/contracts.js";

export interface FrameworkContract {
  readonly schema: Readonly<Record<string, unknown>>;
  /** How many provider packages one session admits. */
  readonly providers: "single" | "many";
  /** The kernel reads values of this contract itself. */
  readonly kernel: boolean;
}

export const frameworkContracts: Readonly<Record<string, FrameworkContract>> =
  Object.freeze({
    // The story shape every `outputKind: story` runtime returns. The
    // automatically scheduled story runtime of a package provides it without
    // declaring it; a session has one such package.
    [STORY_OUTPUT_CONTRACT]: Object.freeze({
      schema: {
        $id: `contract:${STORY_OUTPUT_CONTRACT}`,
        title: "Covel story output",
        ...storyOutputJsonSchema(),
      },
      providers: "single",
      kernel: true,
    }),
    [CHARACTER_ACTOR_CONTRACT]: Object.freeze({
      schema: characterActorOutputJsonSchema(),
      providers: "many",
      kernel: false,
    }),
  });

/** The schema of each framework contract, as the loader resolves `contract:<id>`. */
export const frameworkContractSchemas: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(frameworkContracts).map(([id, contract]) => [
      id,
      contract.schema,
    ]),
  ),
);

/** Whether a session admits only one provider package of this contract. */
export function isSingleProviderContract(contract: string): boolean {
  return (
    isFrameworkContract(contract) &&
    frameworkContracts[contract]!.providers === "single"
  );
}

/**
 * A runtime whose output is a public story: the kernel commits it as the
 * turn's narrative, presentation reads it and auto-advance follows its
 * `yield`. The output kind decides, never the contract the runtime names.
 */
export function isPublicStoryRuntime(runtime: {
  readonly outputKind?: string;
  readonly concealed?: boolean;
}): boolean {
  return runtime.outputKind === "story" && runtime.concealed !== true;
}

/**
 * Whether a runtime provides the story contract: a story runtime the
 * scheduler starts by itself. A manual, event or sub-agent story runtime
 * writes a story when it is started, but does not compete for the turn's
 * story. Fields are as authored; an omitted trigger is `auto`.
 */
export function providesStoryContract(runtime: {
  readonly visibility?: unknown;
  readonly triggerType?: unknown;
  readonly subagentOnly?: unknown;
}): boolean {
  return (
    runtime.visibility === "story" &&
    runtime.subagentOnly !== true &&
    (runtime.triggerType ?? "auto") === "auto"
  );
}

/** Whether the framework supplies this contract's schema. */
export function isFrameworkContract(contract: string): boolean {
  return Object.hasOwn(frameworkContracts, contract);
}
