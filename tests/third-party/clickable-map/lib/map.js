/**
 * The map this example ships with, and the one rule of travel: you may move
 * only along a link. Both runtimes and the summary read it from here, so the
 * widget never has to be trusted with the rules — it draws what the stored
 * state says and asks.
 */

export const MAP_NAMESPACE = "map";
export const MAP_KEY = "state";

const PLACES = [
  {
    id: "docks",
    name: { zh: "码头", en: "Docks" },
    x: 80,
    y: 210,
    links: ["market", "lighthouse"],
  },
  {
    id: "market",
    name: { zh: "集市", en: "Market" },
    x: 220,
    y: 150,
    links: ["docks", "archive", "gate"],
  },
  {
    id: "lighthouse",
    name: { zh: "灯塔", en: "Lighthouse" },
    x: 60,
    y: 70,
    links: ["docks"],
  },
  {
    id: "archive",
    name: { zh: "档案馆", en: "Archive" },
    x: 330,
    y: 70,
    links: ["market"],
  },
  {
    id: "gate",
    name: { zh: "城门", en: "City Gate" },
    x: 360,
    y: 220,
    links: ["market"],
  },
];

/** A fresh map: every place, the player at the docks. */
export function defaultState() {
  return {
    places: PLACES,
    current: "docks",
    visited: ["docks"],
    moves: 0,
  };
}

/** The stored state if it is one, otherwise nothing. */
export function readState(value) {
  return value &&
    typeof value === "object" &&
    Array.isArray(value.places) &&
    typeof value.current === "string"
    ? value
    : undefined;
}

/**
 * The state after moving to `locationId`, or the reason the move is not
 * allowed.
 */
export function travel(state, locationId) {
  const here = state.places.find((place) => place.id === state.current);
  const there = state.places.find((place) => place.id === locationId);
  if (!there) return { ok: false, reason: "unknown-place" };
  if (there.id === state.current) return { ok: false, reason: "already-here" };
  if (!here?.links.includes(there.id))
    return { ok: false, reason: "not-linked" };
  return {
    ok: true,
    state: {
      ...state,
      current: there.id,
      visited: state.visited.includes(there.id)
        ? state.visited
        : [...state.visited, there.id],
      moves: state.moves + 1,
    },
  };
}
