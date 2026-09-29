/**
 * Unified server entry (PLUGIN.md `entry`) — registers director's
 * prompt segment.
 */
import { preambleForLocale } from "../hooks/_preamble.js";

export default function (covel) {
  covel.provideExtension("prompt.segment@1", "direction", {
    handler: (_input, ctx) => [
      {
        id: "direction",
        content: preambleForLocale(ctx.locale),
        position: "system",
        audience: "story",
        volatility: "stable",
      },
    ],
  });
}
