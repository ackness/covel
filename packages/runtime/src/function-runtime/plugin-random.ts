import { createHmac, randomInt } from "node:crypto";
import { readEnvString } from "@covel/shared";
import type { PluginRandom } from "@covel/shared/plugin-runtime";

/** `randomInt` of node:crypto accepts no wider range. */
const MAX_RANGE = 2 ** 48;

/**
 * How many numbers each stream of a session has given. Only a seeded server
 * fills it, and a seeded server is a test server: one entry for each session
 * and stream it ran.
 */
const drawn = new Map<string, number>();

const streamKey = (sessionId: string, pluginId: string, stream: string) =>
  JSON.stringify([sessionId, pluginId, stream]);

/**
 * A session created under an ID that was used before starts every stream
 * again, so a test server can run the same scripted session twice.
 */
export function restartSessionRandom(sessionId: string): void {
  const prefix = `${JSON.stringify([sessionId]).slice(0, -1)},`;
  for (const key of drawn.keys()) if (key.startsWith(prefix)) drawn.delete(key);
}

/**
 * `ctx.random` of one plugin context. Without `COVEL_RANDOM_SEED` it is
 * `randomInt` of node:crypto. With the seed, the n-th number of a stream is a
 * function of the seed, the plugin, the stream and n: two runtimes that draw
 * at the same time do not change each other's numbers, and the session ID is
 * no part of the value.
 */
export function createPluginRandom(scope: {
  readonly sessionId: string;
  readonly pluginId: string;
  /** The runtime, or the RPC action, that draws. */
  readonly stream: string;
}): PluginRandom {
  return Object.freeze({
    int(min: number, max: number): number {
      const seed = readEnvString("COVEL_RANDOM_SEED");
      if (seed === undefined) return randomInt(min, max);
      if (
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max) ||
        max <= min ||
        max - min > MAX_RANGE
      )
        throw new RangeError(
          `ctx.random.int needs safe integers with min < max: ${min}, ${max}`,
        );
      const key = streamKey(scope.sessionId, scope.pluginId, scope.stream);
      const index = drawn.get(key) ?? 0;
      drawn.set(key, index + 1);
      const digest = createHmac("sha256", seed)
        .update(JSON.stringify([scope.pluginId, scope.stream, index]))
        .digest();
      return min + (digest.readUIntBE(0, 6) % (max - min));
    },
  });
}
