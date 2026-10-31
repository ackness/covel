import { makeRandom } from "@covel/plugin-test-utils";
export const characters = [
  { id: "mara", name: "Mara", aliases: ["Captain"] },
  { id: "ivo", name: "Ivo", aliases: ["Keeper"] },
  { id: "president", name: "President" },
  { id: "vice", name: "Vice President Shiraishi" },
  { id: "away", name: "Absent" },
];
export const present = characters
  .slice(0, 4)
  .map(({ id, name }) => ({ characterId: id, name }));
export function input(overrides = {}) {
  return {
    actions: [],
    present,
    recentSegments: [],
    limits: { maxActors: 4, maxSubagentCalls: 16 },
    ...overrides,
  };
}
export function context(settings = {}, overrides = {}) {
  return {
    signal: new AbortController().signal,
    getOwnSettings: () => settings,
    world: {
      characters,
      seats: [
        { id: "host-seat", controller: "human", role: "host", characters: [] },
      ],
    },
    random: makeRandom(7),
    ...overrides,
  };
}
