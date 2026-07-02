import type {
  GeneratedImageSource,
  ImageGenerationParams,
  ImageGenerationResult,
  ImageWire,
} from "./types.js";
import type { ProviderConfig } from "../types.js";

/** `{base}/v1/images/generations`; tolerates baseUrl already ending in /v1. */
function imagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1")
    ? `${trimmed}/images/generations`
    : `${trimmed}/v1/images/generations`;
}

/** DashScope-style "1024*1024" → OpenAI "1024x1024". */
function normalizeSize(size: string): string {
  return size.trim().replace("*", "x").toLowerCase();
}

const BARE_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function toImageSource(
  value: string,
  mime: string,
): GeneratedImageSource | null {
  if (/^https?:\/\//.test(value)) return { kind: "url", url: value, mime };
  const dataUri = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(value);
  if (dataUri) {
    return {
      kind: "bytes",
      bytes: Buffer.from(dataUri[2]!, "base64"),
      mime: dataUri[1]!,
    };
  }
  if (value.length >= 64 && value.length % 4 === 0 && BARE_B64_RE.test(value)) {
    return { kind: "bytes", bytes: Buffer.from(value, "base64"), mime };
  }
  return null;
}

function mimeOf(record: Record<string, unknown>, fallback: string): string {
  for (const key of ["mime", "mimeType", "mediaType"]) {
    const v = record[key];
    if (typeof v === "string" && v.startsWith("image/")) return v;
  }
  return fallback;
}

function collectImages(json: Record<string, unknown>): GeneratedImageSource[] {
  const fallbackMime =
    typeof json.output_format === "string"
      ? `image/${json.output_format}`
      : "image/png";
  const out: GeneratedImageSource[] = [];

  const data = Array.isArray(json.data) ? json.data : [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const value =
      typeof rec.b64_json === "string"
        ? rec.b64_json
        : typeof rec.url === "string"
          ? rec.url
          : null;
    if (!value) continue;
    const src = toImageSource(value, mimeOf(rec, fallbackMime));
    if (src) out.push(src);
  }
  if (out.length > 0) return out;

  // Third-party shims nest images under chat-completion shapes.
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    const content = (choice as { message?: { content?: unknown } })?.message
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const value = [rec.image, rec.url, rec.b64_json].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (!value) continue;
      const src = toImageSource(value, mimeOf(rec, fallbackMime));
      if (src) out.push(src);
    }
  }
  return out;
}

async function generate(
  config: ProviderConfig,
  params: ImageGenerationParams,
): Promise<ImageGenerationResult> {
  const endpoint = imagesEndpoint(config.baseUrl ?? "");
  if (!endpoint) throw new Error("openai-images wire: baseUrl is required");

  // ponytail: imageWire is a routing hint consumed by the caller before it
  // reaches here, not a real request param — strip it so it never leaks
  // onto the wire.
  const { imageWire: _ignored, ...extra } =
    params.providerRequestMetadata ?? {};

  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    n: params.n ?? 1,
    ...(params.size ? { size: normalizeSize(params.size) } : {}),
    ...(params.quality ? { quality: params.quality } : {}),
    ...(params.background ? { background: params.background } : {}),
    ...extra,
  };
  const warnings: string[] = [];
  if (params.negativePrompt) {
    warnings.push(
      "openai-images wire has no negative-prompt field; fold it into the prompt",
    );
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey ?? ""}`,
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: config.signal ?? null,
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `openai-images wire: provider returned non-JSON response (HTTP ${res.status})`,
    );
  }
  if (!res.ok) {
    const err = json.error as { message?: string } | string | undefined;
    const message =
      (typeof err === "object" && err?.message) ||
      (typeof err === "string" && err) ||
      text.slice(0, 1000) ||
      res.statusText;
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${message}`);
  }

  const images = collectImages(json);
  if (images.length === 0) {
    throw new Error("openai-images wire: response contained no images");
  }
  return { images, usage: null, warnings };
}

export const openAiImagesWire: ImageWire = { id: "openai-images", generate };
