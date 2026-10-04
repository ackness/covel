/**
 * Server entry (PLUGIN.md `entry`) — projects the track that should play now
 * into the `stage.music@1` slot, and tells the narrative which moods this
 * world has music for.
 */
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

const own = async (ctx, namespace, key) =>
  (await ctx.pluginData.get(namespace, key))?.value;
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
      const moods = moodVocabulary(await own(ctx, TRACKS_NS, REGISTRY_KEY));
      if (moods.length === 0) return [];
      const lines = moods.map(({ id, when }) =>
        when ? `- ${id}: ${when}` : `- ${id}`,
      );
      return [
        {
          id: "music-moods",
          content: `<music-moods>\nThis world has music for the moods below. When the mood of the story clearly changes to one of them, emit \`music.cue\` with that mood, written exactly as listed. Emit at most once per turn, and not while the mood stays the same. The mood \`silence\` stops the music.\n${lines.join("\n")}\n</music-moods>`,
          position: "system",
          audience: "story",
          volatility: "session",
        },
      ];
    },
  });
  covel.provideExtension("ui.slot@1", "music", {
    async handler({ previous, events }, ctx) {
      const registry = await own(ctx, TRACKS_NS, REGISTRY_KEY);
      const tracks = Array.isArray(registry?.tracks) ? registry.tracks : [];
      // A world without a track list leaves the slot to other providers.
      if (tracks.length === 0) return previous;

      const [mood, scene] = await Promise.all([
        own(ctx, STATE_NS, MOOD_KEY),
        own(ctx, STATE_NS, SCENE_KEY),
      ]);
      const track = selectTrack(
        tracks,
        applyEvents({ mood: mood?.mood, scene: scene?.name }, events),
      );
      if (!track) return {};
      const ref = (await own(ctx, ASSETS_NS, track.file))?.ref;
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
