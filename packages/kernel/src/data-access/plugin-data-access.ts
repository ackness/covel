import type {
  PluginDataAccess,
  RecordEntry,
  RecordQuery,
  EventEntry,
  ProposalItem,
  BlockInteraction,
  CharacterCard,
  CharacterCreateInput,
} from "@covel/shared";
import type { TurnState } from "../types.js";

export interface DataAccessSources {
  turnState: TurnState;
  characters: CharacterCard[];
  events: EventEntry[];
}

/**
 * Create a PluginDataAccess instance scoped to a specific runtime execution.
 * Reads from the current turn state; writes produce proposal items.
 */
export function createPluginDataAccess(
  sources: DataAccessSources
): PluginDataAccess {
  const { turnState, characters, events } = sources;

  return {
    state: {
      get(scope: string, key: string): unknown {
        const scopedState = turnState.state as Record<string, unknown>;
        const scopeData = scopedState[scope] as Record<string, unknown> | undefined;
        return scopeData?.[key];
      },
      getScope(scope: string): Record<string, unknown> {
        const scopedState = turnState.state as Record<string, unknown>;
        return (scopedState[scope] as Record<string, unknown>) ?? {};
      },
      getAll(): Record<string, unknown> {
        return { ...turnState.state };
      },
    },

    records: {
      get(key: string): unknown {
        return turnState.records.get(key);
      },
      find(query: RecordQuery): RecordEntry[] {
        const entries: RecordEntry[] = [];
        for (const [key, value] of turnState.records) {
          const record = value as Record<string, unknown>;
          if (query.recordType && record.recordType !== query.recordType) continue;
          if (query.fieldMatch) {
            const fields = (record.fields ?? record) as Record<string, unknown>;
            const matches = Object.entries(query.fieldMatch).every(
              ([k, v]) => fields[k] === v
            );
            if (!matches) continue;
          }
          entries.push({
            key,
            recordType: (record.recordType as string) ?? "unknown",
            fields: (record.fields ?? record) as Record<string, unknown>,
          });
          if (query.limit && entries.length >= query.limit) break;
        }
        return entries;
      },
      list(recordType?: string): RecordEntry[] {
        const entries: RecordEntry[] = [];
        for (const [key, value] of turnState.records) {
          const record = value as Record<string, unknown>;
          if (recordType && record.recordType !== recordType) continue;
          entries.push({
            key,
            recordType: (record.recordType as string) ?? "unknown",
            fields: (record.fields ?? record) as Record<string, unknown>,
          });
        }
        return entries;
      },
    },

    characters: {
      get(id: string): CharacterCard | undefined {
        return characters.find((c) => c.id === id);
      },
      findByName(name: string): CharacterCard | undefined {
        const lower = name.toLowerCase();
        return characters.find((c) => c.name.toLowerCase().includes(lower));
      },
      list(): CharacterCard[] {
        return [...characters];
      },
      listByType(type: string): CharacterCard[] {
        return characters.filter((c) => c.type === type);
      },
    },

    events: {
      recent(limit = 20): EventEntry[] {
        return events.slice(-limit);
      },
      findByType(eventType: string, limit = 10): EventEntry[] {
        return events
          .filter((e) => e.eventType === eventType)
          .slice(-limit);
      },
    },

    propose: {
      statePatch(scope: string, patch: Record<string, unknown>): ProposalItem {
        return { kind: "state.patch", payload: { [scope]: patch } };
      },
      eventEmit(eventType: string, data?: Record<string, unknown>): ProposalItem {
        return { kind: "event.emit", payload: { eventType, data } };
      },
      recordUpsert(recordType: string, key: string, fields: Record<string, unknown>): ProposalItem {
        return { kind: "record.upsert", payload: { key, value: { recordType, fields } } };
      },
      narrativeAppend(text: string): ProposalItem {
        return { kind: "narrative.append", payload: { text } };
      },
      uiRender(blockType: string, data: unknown, interaction?: BlockInteraction): ProposalItem {
        return {
          kind: "ui.render",
          payload: { type: blockType, content: data, interaction },
        };
      },
      characterCreate(input: CharacterCreateInput): ProposalItem {
        return {
          kind: "record.upsert",
          payload: {
            key: `character:${input.name}`,
            value: {
              recordType: "character",
              fields: {
                name: input.name,
                type: input.type ?? "player",
                description: input.description ?? "",
                ...input.fields,
              },
            },
          },
        };
      },
      characterUpdate(
        id: string,
        patch: Partial<Pick<CharacterCard, "name" | "description" | "fields" | "extensions">>
      ): ProposalItem {
        return {
          kind: "record.upsert",
          payload: {
            key: `character:${id}`,
            value: {
              recordType: "character_update",
              fields: { characterId: id, ...patch },
            },
          },
        };
      },
    },
  };
}
