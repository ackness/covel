/**
 * Server entry (PLUGIN.md `entry`) — projects the track that should play now
 * into the `stage.music@1` slot, and tells the narrative which moods this
 * world has music for.
 */
import { pickLocaleText } from "@covel/plugin-handlers-utils";
import {
  ASSETS_NS,
  MOOD_KEY,
  REGISTRY_KEY,
  SCENE_KEY,
  STATE_NS,
  TRACKS_NS,
  applyEvents,
  moodVocabulary,
  selectTrack,
} from "../lib/soundtrack.js";

const isAudioRef = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.id === "string" &&
  typeof value.mime === "string" &&
  value.mime.startsWith("audio/") &&
  typeof value.size === "number";

export default function (covel) {
  // The moods are the world author's words, so the narrative cannot know them
  // from the event's description. A world that names no mood gets no segment,
  // and the narrative has nothing to cue.
  covel.provideExtension("prompt.segment@1", "music-moods", {
    async handler(_input, ctx) {
      const moods = moodVocabulary(
        await ctx.pluginData.get(TRACKS_NS, REGISTRY_KEY),
      );
      if (moods.length === 0) return [];
      const lines = moods.map(({ id, when }) =>
        when ? `- ${id}: ${when}` : `- ${id}`,
      );
      const instruction = pickLocaleText(
        ctx.locale,
        "这个世界为下面这些情绪配了音乐。故事的情绪明显变成其中某一种时，发射 `music.cue` 并带上这种情绪，按列出的写法原样填写。每回合最多发射一次，情绪没有变化时不要发射。情绪 `silence` 会停止音乐。",
        "This world has music for the moods below. When the mood of the story clearly changes to one of them, emit `music.cue` with that mood, written exactly as listed. Emit at most once per turn, and not while the mood stays the same. The mood `silence` stops the music.",
      );
      return [
        {
          id: "music-moods",
          content: `<music-moods>\n${instruction}\n${lines.join("\n")}\n</music-moods>`,
          position: "system",
          audience: "story",
          volatility: "session",
        },
      ];
    },
  });
  covel.provideExtension("ui.slot@1", "music", {
    async handler({ previous, events }, ctx) {
      const registry = await ctx.pluginData.get(TRACKS_NS, REGISTRY_KEY);
      const tracks = Array.isArray(registry?.tracks) ? registry.tracks : [];
      // A world without a track list leaves the slot to other providers.
      if (tracks.length === 0) return previous;

      const [mood, scene] = await Promise.all([
        ctx.pluginData.get(STATE_NS, MOOD_KEY),
        ctx.pluginData.get(STATE_NS, SCENE_KEY),
      ]);
      const track = selectTrack(
        tracks,
        applyEvents({ mood: mood?.mood, scene: scene?.name }, events),
      );
      if (!track) return {};
      const ref = (await ctx.pluginData.get(ASSETS_NS, track.file))?.ref;
      // A track whose file the world did not ship is silence, not an error.
      if (!isAudioRef(ref)) return {};
      return {
        trackId: track.id,
        ...(typeof track.title === "string" && track.title
          ? { title: track.title }
          : {}),
        ref,
        ...(track.loop === false ? { loop: false } : {}),
        ...(typeof track.volume === "number" ? { volume: track.volume } : {}),
      };
    },
  });
}
