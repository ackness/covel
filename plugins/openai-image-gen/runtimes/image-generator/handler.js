/**
 * @covel/plugin-openai-image-gen — image-generator handler
 *
 * Triggered by `openai-image.generate.requested` from the sibling
 * `prompt-generator` agent. Generation goes through the framework's unified
 * `ctx.images.generate()` pipeline: the kernel picks the wire from the
 * resolved slot (`modelPresetId` → `[covel.<slot>]` in `~/.covel/llm.toml`),
 * handles the HTTP call + SSRF guard + response parsing + promptHash dedup,
 * and persists bytes into MediaStore. Switching providers is a pure
 * llm.toml edit — no plugin code changes.
 *
 * The provider-agnostic trunk (prompt extraction, pending record, gallery
 * fan-out, failure cards) lives in @covel/plugin-handlers-utils
 * `runImageGeneration`; this file only declares what is openai-specific:
 * the event topic, the default preset, the `composition` prompt field, the
 * OpenAI size normalization, and the style-into-prompt folding.
 *
 * Execution mode: `background` — the framework writes a `_jobs/<jobId>`
 * pending record before invoking this handler. The right-panel gallery
 * subscribes to `plugin-data.changed` SSE on the `images` namespace and
 * re-renders when commit lands.
 */

import {
  optionalNumber,
  optionalString,
  runImageGeneration,
} from "@covel/plugin-handlers-utils";

const DEFAULT_REQUEST_TIMEOUT_MS = 300000;

function normalizeImageSize(value) {
  // OpenAI Images API expects lowercase "1024x1024". The UI/help text may
  // contain the common DashScope-style "1024*1024"; normalize it so users do
  // not have to remember which provider wants which separator.
  return String(value ?? "1024x1024")
    .trim()
    .replace("*", "x")
    .toLowerCase();
}

/** @type {import('@covel/plugin-loader').FunctionHandler} */
export default async function imageGeneratorHandler(ctx) {
  return runImageGeneration(ctx, {
    source: "openai-image-gen",
    triggerTopic: "openai-image.generate.requested",
    extraPromptFields: { composition: "single-scene" },
    planRequest(settings, { prompt }) {
      const style = optionalString(settings.style) ?? "";
      // Style has no dedicated wire parameter in ctx.images.generate — fold
      // it into the prompt text, same as any free-form prompt embellishment.
      const finalPrompt = style ? `${prompt}, style: ${style}` : prompt;
      const timeout = optionalNumber(settings.requestTimeoutMs);
      const n = optionalNumber(settings.n);
      return {
        prompt: finalPrompt,
        presetId: optionalString(settings.modelPresetId) ?? "openai-image",
        size: normalizeImageSize(optionalString(settings.imageSize)),
        n: n !== undefined && n >= 1 ? Math.floor(n) : 1,
        requestTimeoutMs:
          timeout !== undefined && timeout > 0
            ? Math.floor(timeout)
            : DEFAULT_REQUEST_TIMEOUT_MS,
        ...(optionalString(settings.quality)
          ? { quality: optionalString(settings.quality) }
          : {}),
      };
    },
  });
}
