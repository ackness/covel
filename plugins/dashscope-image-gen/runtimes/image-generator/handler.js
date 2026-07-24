/**
 * @covel/plugin-dashscope-image-gen — image-generator handler
 *
 * Triggered by the `image.generate.requested` event from the sibling
 * `prompt-generator` agent. Generation goes through the framework's unified
 * `ctx.images.generate()` pipeline: the kernel picks the wire from the
 * resolved slot (`modelPresetId` → `[covel.<slot>]` in `~/.covel/llm.toml`,
 * `providerRequestMetadata.imageWire = "dashscope-wan"`), which handles the
 * DashScope wan2.x async task (submit + poll), the `x`→`*` size-separator
 * conversion, per-model negative_prompt / `n` handling, the
 * `X-DashScope-Async` header, SSRF/redirect guarding, and OSS URL ingestion
 * into the framework MediaStore.
 *
 * The provider-agnostic trunk (prompt extraction, pending record, gallery
 * fan-out, failure cards) lives in @covel/plugin-handlers-utils
 * `runImageGeneration`; this file only declares what is dashscope-specific:
 * the event topic, the default preset, and the userSettings mapping
 * (negativePrompt passthrough + quality display field).
 *
 * Execution mode: `background` (declared in PLUGIN.md). The framework
 * writes a `_jobs/<jobId>` pending record before invoking this handler
 * and defers the call so the HTTP response flushes immediately. Right-
 * panel gallery subscribes to `plugin-data.changed` SSE on the `images`
 * namespace and re-renders when the commit lands.
 */

import {
  optionalNumber,
  optionalString,
  runImageGeneration,
} from "@covel/plugin-handlers-utils";

const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

/** @type {import('@covel/plugin-loader').FunctionHandler} */
export default async function imageGeneratorHandler(ctx) {
  return runImageGeneration(ctx, {
    source: "dashscope-image-gen",
    triggerTopic: "image.generate.requested",
    planRequest(settings, { prompt }) {
      const quality = optionalString(settings.quality) ?? "low";
      const negativePrompt =
        typeof settings.negativePrompt === "string"
          ? settings.negativePrompt
          : "";
      const timeout = optionalNumber(settings.requestTimeoutMs);
      const n = optionalNumber(settings.n);
      return {
        prompt,
        presetId: optionalString(settings.modelPresetId) ?? "image",
        size: optionalString(settings.imageSize) ?? "1024x1024",
        n: n !== undefined && n >= 1 ? Math.floor(n) : 1,
        requestTimeoutMs:
          timeout !== undefined && timeout > 0
            ? timeout
            : DEFAULT_REQUEST_TIMEOUT_MS,
        quality,
        ...(negativePrompt ? { negativePrompt } : {}),
        // quality is display-only for wan2.x; keep it on the gallery record.
        recordFields: { quality },
      };
    },
  });
}
