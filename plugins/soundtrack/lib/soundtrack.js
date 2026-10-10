/**
 * Shared plugin_data names and the one rule that chooses a track.
 *
 * The two event runtimes only record facts — the mood, the scene — each under
 * its own key, so a turn that sets both cannot lose one to the other. The
 * track is chosen when the `stage.music@1` slot is projected, from those facts
 * and the world's track list. The same facts always give the same track, so a
 * reload or a resumed session lands on the same music.
 */

import {
  makeProposal,
  mentionedCharacterIds,
} from "@covel/plugin-handlers-utils";

export const TRACKS_NS = "tracks";
export const REGISTRY_KEY = "music-registry";
export const ASSETS_NS = "assets";
export const STATE_NS = "state";
export const MOOD_KEY = "mood";
export const SCENE_KEY = "scene";

/** A cue with this mood stops the music. */
export const SILENCE = "silence";

/**
 * The moods of a world's music: the names the track list declares, then any
 * a track uses without declaring it. The names are the author's; the plugin
 * fixes none. A world whose tracks name no mood has an empty list, and its
 * music follows the scene and the theme only.
 *
 * @param {Record<string, unknown> | null | undefined} registry
 * @returns {{ id: string, when?: string }[]}
 */
export function moodVocabulary(registry) {
  const moods = new Map();
  const add = (id, when) => {
    const name = typeof id === "string" ? id.trim() : "";
    if (!name || normalize(name) === SILENCE || moods.has(normalize(name)))
      return;
    moods.set(normalize(name), {
      id: name,
      ...(typeof when === "string" && when.trim() ? { when: when.trim() } : {}),
    });
  };
  for (const mood of Array.isArray(registry?.moods) ? registry.moods : [])
    add(mood?.id, mood?.when);
  for (const track of Array.isArray(registry?.tracks) ? registry.tracks : [])
    for (const mood of Array.isArray(track?.moods) ? track.moods : [])
      add(mood);
  return [...moods.values()];
}

function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * Whether a track's scene names cover the current scene: the same name, or a
 * track name written as a whole name inside it ("The Crooked Stag" covers "The
 * Crooked Stag, taproom"). A name inside a longer word or inside a longer name
 * of another of the track's scenes does not count: "Hall" is not "Great Hall",
 * and "inn" is not in "Dunn".
 *
 * @param {unknown} scenes
 * @param {string | undefined} scene
 */
export function matchesScene(scenes, scene) {
  const here = normalize(scene);
  if (!here || !Array.isArray(scenes)) return false;
  const names = scenes.filter((name) => typeof name === "string");
  if (names.some((name) => normalize(name) === here)) return true;
  const spaced = String(scene).trim().replace(/\s+/g, " ");
  return (
    mentionedCharacterIds(
      spaced,
      names.map((name, index) => ({
        id: String(index),
        name: name.trim().replace(/\s+/g, " "),
      })),
    ).size > 0
  );
}

/**
 * Choose the track for a mood and a scene. Earlier tracks win within a rule:
 *
 * 1. a track for this mood in this scene;
 * 2. a track for this mood anywhere;
 * 3. the scene's own track (one that answers no mood);
 * 4. the theme of the world;
 * 5. silence.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} tracks
 * @param {{ mood?: string, scene?: string }} facts
 * @returns {Record<string, unknown> | null}
 */
export function selectTrack(tracks, { mood, scene }) {
  if (normalize(mood) === SILENCE) return null;
  const usable = tracks.filter(
    (track) =>
      track &&
      typeof track === "object" &&
      typeof track.id === "string" &&
      typeof track.file === "string",
  );
  const has = (list) => Array.isArray(list) && list.length > 0;
  const feels = (track) =>
    Boolean(mood) &&
    has(track.moods) &&
    track.moods.some((name) => normalize(name) === normalize(mood));
  const here = (track) => matchesScene(track.scenes, scene);
  return (
    usable.find((track) => feels(track) && here(track)) ??
    usable.find((track) => feels(track) && !has(track.scenes)) ??
    usable.find((track) => here(track) && !has(track.moods)) ??
    usable.find((track) => track.theme === true) ??
    null
  );
}

/**
 * The mood and scene of a turn in progress: the recorded facts with the
 * turn's own events applied, so the music follows before the turn commits.
 *
 * @param {{ mood?: string, scene?: string }} facts
 * @param {ReadonlyArray<{ topic: string, data: Record<string, unknown> }>} events
 */
export function applyEvents(facts, events) {
  let { mood, scene } = facts;
  for (const event of events) {
    if (event.topic === "music.cue" && typeof event.data.mood === "string")
      mood = event.data.mood;
    if (
      event.topic === "scene.set" &&
      typeof event.data.location === "string" &&
      event.data.location.trim()
    )
      scene = event.data.location.trim();
  }
  return { mood, scene };
}

/**
 * The `plugin.data` proposal that records one fact.
 *
 * @param {import('@covel/plugin-handlers-utils').PluginFunctionContext} ctx
 * @param {string} key
 * @param {Record<string, unknown>} value
 */
export function makeFactProposal(ctx, key, value) {
  return makeProposal(ctx, new Date().toISOString(), "plugin.data", {
    namespace: STATE_NS,
    key,
    value: { ...value, turnId: ctx.turnId },
  });
}
