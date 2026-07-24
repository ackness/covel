import type {
  GeneratedImageSource,
  ImageGenerationParams,
  ImageGenerationResult,
  ImageWire,
} from "./types.js";
import type { ModelRequestContext, ProviderConfig } from "../types.js";
import {
  assertSuccess,
  getJson,
  isRetriableStatus,
  parseJson,
  postJson,
  sleepWithAbort,
} from "../adapters/http.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;

interface WanPollOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** DashScope wants star-separated sizes: "1024x1536" → "1024*1536". */
function toStarSize(size: string): string {
  const m = /^(\d{3,4})\s*[x*×]\s*(\d{3,4})$/i.exec(size.trim());
  if (m) return `${m[1]}*${m[2]}`;
  return size.replace(/[x×]/gi, "*");
}

function modelRejectsNegativePrompt(model: string): boolean {
  return model.startsWith("wan2.7-image");
}

/**
 * Qwen-Image models (qwen-image-3.0-pro & the earlier qwen-image line) ride
 * DashScope's SYNCHRONOUS multimodal endpoint — same messages input and
 * choices[] output shape as wan2.6+, but no async header and no task
 * polling: the submit response carries the images directly.
 */
function isQwenImageModel(model: string): boolean {
  return model.startsWith("qwen-image");
}

/**
 * Per-task image-count caps: qwen-image-3.* accepts `n` 1–6;
 * wan2.6-image / wan2.6-t2i / wan2.7-image* accept 1–4 (the wan2.7 group
 * mode raises it to 12 behind `enable_sequential`, which this wire does not
 * drive). Everything else — earlier wan2.x and the pre-3.0 qwen-image line,
 * whose docs state no multi-image support — is a single-image task.
 */
function modelMaxImages(model: string): number {
  if (model.startsWith("qwen-image-3")) return 6;
  if (
    model.startsWith("wan2.6-image") ||
    model.startsWith("wan2.6-t2i") ||
    model.startsWith("wan2.7-image")
  ) {
    return 4;
  }
  return 1;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function mimeOf(rec: Record<string, unknown>): string {
  for (const key of ["mime", "mimeType", "mediaType", "mime_type"]) {
    const v = rec[key];
    if (typeof v === "string" && v.startsWith("image/")) return v;
  }
  return "image/png";
}

function collectResults(
  output: Record<string, unknown>,
): GeneratedImageSource[] {
  const out: GeneratedImageSource[] = [];
  const push = (rec: Record<string, unknown>) => {
    const value = [
      rec.image,
      rec.url,
      rec.dataUrl,
      rec.base64,
      rec.b64_json,
    ].find((v): v is string => typeof v === "string" && v.length > 0);
    if (!value) return;
    const mime = mimeOf(rec);
    if (/^https?:\/\//.test(value)) out.push({ kind: "url", url: value, mime });
    else
      out.push({
        kind: "bytes",
        bytes: Buffer.from(value.replace(/^data:[^,]+,/, ""), "base64"),
        mime,
      });
  };

  for (const raw of Array.isArray(output.results) ? output.results : []) {
    const rec = asRecord(raw);
    if (rec) push(rec);
  }
  if (out.length > 0) return out;
  for (const choice of Array.isArray(output.choices) ? output.choices : []) {
    const content = asRecord(asRecord(choice)?.message)?.content;
    for (const raw of Array.isArray(content) ? content : []) {
      const rec = asRecord(raw);
      if (rec) push(rec);
    }
  }
  return out;
}

async function generate(
  config: ProviderConfig,
  params: ImageGenerationParams,
  _context?: ModelRequestContext,
  poll?: WanPollOptions,
): Promise<ImageGenerationResult> {
  const warnings: string[] = [];

  const requestedN = Math.max(1, Math.floor(params.n ?? 1));
  const maxN = modelMaxImages(params.model);
  const n = Math.min(requestedN, maxN);
  const parameters: Record<string, unknown> = {
    ...(params.size ? { size: toStarSize(params.size) } : {}),
    n,
    watermark: false,
  };
  if (params.negativePrompt) {
    if (modelRejectsNegativePrompt(params.model)) {
      warnings.push(`model ${params.model} rejects negative_prompt; dropped`);
    } else {
      parameters.negative_prompt = params.negativePrompt;
    }
  }
  if (params.background === "transparent") {
    warnings.push(
      "dashscope-wan has no transparent-background parameter; prompt-only",
    );
  }
  if (requestedN > n) {
    warnings.push(
      maxN === 1
        ? "dashscope-wan generates a single image per task on this model; n clamped to 1"
        : `dashscope-wan caps n at ${maxN} for ${params.model}; n clamped to ${maxN}`,
    );
  }

  const body = {
    model: params.model,
    input: {
      messages: [{ role: "user", content: [{ text: params.prompt }] }],
    },
    parameters,
  };

  // Qwen-Image path: synchronous multimodal endpoint — the response carries
  // the images directly, no async header, no task polling. `prompt_extend`
  // defaults to true on this endpoint; disabled explicitly because the
  // plugin's prompt agent already writes a full art brief (composition /
  // panel layout instructions) that a platform-side rewrite would mangle.
  if (isQwenImageModel(params.model)) {
    parameters.prompt_extend = false;
    const response = await postJson(
      config,
      "/api/v1/services/aigc/multimodal-generation/generation",
      body,
    );
    const payload = await parseJson(response);
    assertSuccess(response, payload, "dashscope-wan");
    const images = collectResults(asRecord(payload.output) ?? {});
    if (images.length === 0) {
      throw new Error("DashScope qwen-image: no images in response");
    }
    return { images, usage: null, warnings };
  }

  const submitResponse = await postJson(
    config,
    "/api/v1/services/aigc/image-generation/generation",
    body,
    undefined,
    { "X-DashScope-Async": "enable" },
  );
  const submitPayload = await parseJson(submitResponse);
  assertSuccess(submitResponse, submitPayload, "dashscope-wan");
  const taskId = asRecord(submitPayload.output)?.task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("DashScope WAN: no task_id in submit response");
  }

  const pollIntervalMs = poll?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = poll?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const pollPath = `/api/v1/tasks/${encodeURIComponent(taskId)}`;

  while (Date.now() < deadline) {
    const sleepMs = Math.min(
      pollIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs > 0) await sleepWithAbort(sleepMs, config.signal);

    const res = await getJson(config, pollPath);
    if (!res.ok) {
      if (isRetriableStatus(res.status)) continue; // transient — retry next tick
      const errPayload = await parseJson(res);
      assertSuccess(res, errPayload, "dashscope-wan");
    }

    const payload = await parseJson(res);
    const output = asRecord(payload.output);
    const status = output?.task_status;
    if (status === "SUCCEEDED") {
      const images = collectResults(output ?? {});
      if (images.length === 0) {
        throw new Error("DashScope WAN: SUCCEEDED but no images in response");
      }
      return { images, usage: null, warnings };
    }
    // CANCELED / UNKNOWN are terminal too — without this they would poll
    // until the timeout and surface a generic timeout instead of the cause.
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      const msg =
        typeof output?.message === "string" ? output.message : `Task ${status}`;
      throw new Error(`DashScope WAN generation ${status}: ${msg}`);
    }
    // PENDING / RUNNING (or a payload without task_status) → keep polling
  }
  throw new Error(`DashScope WAN: polling timed out after ${timeoutMs}ms`);
}

export const dashscopeWanWire = {
  id: "dashscope-wan",
  generate,
} satisfies ImageWire;
