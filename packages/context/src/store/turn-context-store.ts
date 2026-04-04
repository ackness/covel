import type { CharacterCard } from "@covel/shared";
import type {
  TurnContextInit,
  RuntimeOutput,
  ProposalItem,
} from "../types.js";

/** Recursively merge plain objects; non-object values are overwritten. */
function deepMergeState(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = result[key];
    const sVal = source[key];
    if (
      tVal && sVal &&
      typeof tVal === "object" && !Array.isArray(tVal) &&
      typeof sVal === "object" && !Array.isArray(sVal)
    ) {
      result[key] = deepMergeState(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>,
      );
    } else {
      result[key] = Array.isArray(sVal) ? [...sVal as unknown[]] : sVal;
    }
  }
  return result;
}

export interface TurnContextStore {
  /** Initialize with static context at turn start */
  init(input: TurnContextInit): void;

  /** Ingest output from a completed runtime */
  ingest(output: RuntimeOutput): void;

  /** Get turn metadata */
  getRunId(): string;
  getBranchId(): string;
  getTurnId(): string;
  getLocale(): string;

  /** Get static context */
  getWorld(): unknown;
  getCharacters(): CharacterCard[];
  getChat(): unknown;
  getArchive():
    | { activeVersion?: number; latestVersion?: number; summary?: string }
    | undefined;
  getRuntimeSettings():
    | {
        flat?: Record<string, unknown>;
        byPlugin?: Record<string, Record<string, unknown>>;
      }
    | undefined;

  /** Get accumulated dynamic context */
  getNarrative(): string;
  getState(): Record<string, unknown>;
  getProposals(): ProposalItem[];
  getCompletedRuntimeIds(): string[];
}

export function createTurnContextStore(): TurnContextStore {
  let runId = "";
  let branchId = "";
  let turnId = "";
  let locale = "";
  let world: unknown = undefined;
  let characters: CharacterCard[] = [];
  let chat: unknown = undefined;
  let initialState: Record<string, unknown> = {};
  let archive:
    | { activeVersion?: number; latestVersion?: number; summary?: string }
    | undefined;
  let runtimeSettings:
    | {
        flat?: Record<string, unknown>;
        byPlugin?: Record<string, Record<string, unknown>>;
      }
    | undefined;

  // Dynamic accumulation
  let narrativeSegments: string[] = [];
  let accumulatedPatches: Record<string, unknown>[] = [];
  let allProposals: ProposalItem[] = [];
  let completedRuntimes: string[] = [];

  return {
    init(input: TurnContextInit): void {
      runId = input.runId;
      branchId = input.branchId;
      turnId = input.turnId;
      locale = input.locale;
      world = input.world;
      characters = input.characters ?? [];
      chat = input.chat;
      initialState = { ...input.state };
      archive = input.archive;
      runtimeSettings = input.runtimeSettings;

      // Reset dynamic state
      narrativeSegments = [];
      accumulatedPatches = [];
      allProposals = [];
      completedRuntimes = [];
    },

    ingest(output: RuntimeOutput): void {
      completedRuntimes.push(output.runtimeId);

      if (output.narrative) {
        narrativeSegments.push(output.narrative);
      }

      for (const proposal of output.proposals) {
        allProposals.push(proposal);

        // Eagerly apply state patches and narrative
        switch (proposal.kind) {
          case "narrative.append": {
            const p = proposal.payload as { text: string };
            if (p.text && !output.narrative) {
              // Only add if not already captured in output.narrative
              narrativeSegments.push(p.text);
            }
            break;
          }
          case "state.patch": {
            accumulatedPatches.push(
              proposal.payload as Record<string, unknown>
            );
            break;
          }
        }
      }
    },

    getRunId: () => runId,
    getBranchId: () => branchId,
    getTurnId: () => turnId,
    getLocale: () => locale,
    getWorld: () => world,
    getCharacters: () => characters,
    getChat: () => chat,
    getArchive: () => archive,
    getRuntimeSettings: () => runtimeSettings,

    getNarrative(): string {
      return narrativeSegments.join("");
    },

    getState(): Record<string, unknown> {
      let merged: Record<string, unknown> = { ...initialState };
      for (const patch of accumulatedPatches) {
        merged = deepMergeState(merged, patch);
      }
      return merged;
    },

    getProposals(): ProposalItem[] {
      return [...allProposals];
    },

    getCompletedRuntimeIds(): string[] {
      return [...completedRuntimes];
    },
  };
}
