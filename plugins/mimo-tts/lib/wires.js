/**
 * mimo-tts wires module — registered by the entry module (server/index.js)
 * via `covel.registerWires()`. Exposes the Xiaomi MiMo TTS wire so any slot
 * with `providerRequestMetadata = { speechWire = "mimo-tts/mimo" }` routes
 * `ctx.speech.generate()` through it (the framework namespaces the id).
 *
 * MiMo TTS rides the OpenAI-compatible chat-completions endpoint with two
 * quirks worth pinning:
 *   1. Auth is `api-key: <KEY>` (NOT `Authorization: Bearer …`).
 *   2. The text to speak is sent as `messages: [{ role: 'assistant', content }]`
 *      — counter to OpenAI conventions where assistant text is model output.
 *      Confirmed against the official example (github.com/iChochy/mimo-tts-chat).
 *
 * Wire format (non-streaming):
 *   POST {baseUrl}/v1/chat/completions
 *   { "model", "messages": [{ "role": "assistant", "content": "<text>" }],
 *     "audio": { "format": "wav"|"mp3"|"pcm"|"pcm16", "voice": "<voice id>" } }
 *   → choices[0].message.audio.data  (base64 audio bytes)
 */

const DEFAULT_PATH = "/v1/chat/completions";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_VOICE = "mimo_default";

/** Map MiMo `audio.format` → MIME the framework MediaStore can serve. */
const FORMAT_TO_MIME = Object.freeze({
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/L16",
  pcm16: "audio/L16",
});

const ALLOWED_FORMATS = Object.keys(FORMAT_TO_MIME);

/** OpenAI-compatible payload — base64 audio is at choices[0].message.audio.data. */
function extractAudio(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const audio = choice?.message?.audio;
    if (audio && typeof audio.data === "string" && audio.data.length > 0) {
      return { base64: audio.data };
    }
  }
  throw new Error(
    `mimo-tts: response did not contain choices[0].message.audio.data — payload keys: ${Object.keys(payload ?? {}).join(",") || "<empty>"}`,
  );
}

function decodeBase64(input) {
  const compact = input.replace(/\s+/g, "");
  return Buffer.from(compact, "base64");
}

/**
 * Factory form: the framework injects { fetchWithRetry, validateBaseUrl }
 * so this module needs no @covel/ai-provider import.
 */
export default ({ fetchWithRetry, validateBaseUrl }) => ({
  speech: [
    {
      id: "mimo", // registered as "mimo-tts/mimo"
      /**
       * @param {{ baseUrl?: string, apiKey?: string, signal?: AbortSignal }} config
       * @param {{ model: string, text: string, voice?: string, format?: string,
       *           providerRequestMetadata?: Record<string, unknown> }} params
       */
      async synthesize(config, params) {
        if (!config.baseUrl) throw new Error("mimo-tts: slot baseUrl required");
        if (!config.apiKey) {
          throw new Error(
            "mimo-tts: slot apiKey required — set XIAOMI_API_KEY in keys.env",
          );
        }
        const format = params.format ?? DEFAULT_FORMAT;
        if (!ALLOWED_FORMATS.includes(format)) {
          throw new Error(
            `mimo-tts: unsupported format "${format}"; pick one of ${ALLOWED_FORMATS.join(", ")}`,
          );
        }
        const verdict = validateBaseUrl(config.baseUrl);
        if (!verdict.ok) {
          throw new Error(
            `mimo-tts: invalid baseUrl: ${verdict.reason ?? config.baseUrl}`,
          );
        }

        // Tolerate both `https://host` and `https://host/v1` — OpenAI-compatible
        // base URLs are written either way in the wild.
        const trimmedBase = config.baseUrl
          .replace(/\/$/, "")
          .replace(/\/v1$/, "");
        const response = await fetchWithRetry(`${trimmedBase}${DEFAULT_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "api-key": config.apiKey,
          },
          body: JSON.stringify({
            model: params.model,
            messages: [{ role: "assistant", content: params.text }],
            audio: { format, voice: params.voice ?? DEFAULT_VOICE },
          }),
          signal: config.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `mimo-tts: HTTP ${response.status} ${response.statusText} — ${detail.slice(0, 240)}`,
          );
        }

        const payload = await response.json();
        const { base64 } = extractAudio(payload);
        return {
          audio: {
            mimeType: FORMAT_TO_MIME[format],
            data: decodeBase64(base64),
          },
          usage: null,
          warnings: [],
        };
      },
    },
  ],
});
