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

  const parameters: Record<string, unknown> = {
    ...(params.size ? { size: toStarSize(params.size) } : {}),
    n: 1, // wan2.x supports single-image tasks only
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
  if ((params.n ?? 1) > 1) {
    warnings.push(
      "dashscope-wan generates a single image per task; n clamped to 1",
    );
  }

  const submitResponse = await postJson(
    config,
    "/api/v1/services/aigc/image-generation/generation",
    {
      model: params.model,
      input: {
        messages: [{ role: "user", content: [{ text: params.prompt }] }],
      },
      parameters,
    },
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
    if (status === "FAILED") {
      const msg =
        typeof output?.message === "string" ? output.message : "Task FAILED";
      throw new Error(`DashScope WAN generation FAILED: ${msg}`);
    }
    // PENDING / RUNNING → keep polling
  }
  throw new Error(`DashScope WAN: polling timed out after ${timeoutMs}ms`);
}

export const dashscopeWanWire = {
  id: "dashscope-wan",
  generate,
} satisfies ImageWire;
