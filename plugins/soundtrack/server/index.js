/**
 * Server entry (PLUGIN.md `entry`) — projects the track that should play now
 * into the `stage.music@1` slot.
 */
import {
  ASSETS_NS,
  MOOD_KEY,
  REGISTRY_KEY,
  SCENE_KEY,
  STATE_NS,
  TRACKS_NS,
  applyEvents,
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
