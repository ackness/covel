import type {
  GeneratedImageSource,
  ImageGenerationParams,
  ImageGenerationResult,
} from "./types.js";
import type { ModelRequestContext, ProviderConfig } from "../types.js";

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
  const base = (config.baseUrl ?? "").replace(/\/$/, "");
  if (!base) throw new Error("dashscope-wan wire: baseUrl is required");
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

  const submitRes = await fetch(
    `${base}/api/v1/services/aigc/image-generation/generation`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey ?? ""}`,
        "X-DashScope-Async": "enable",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({
        model: params.model,
        input: {
          messages: [{ role: "user", content: [{ text: params.prompt }] }],
        },
        parameters,
      }),
      signal: config.signal ?? null,
    },
  );
  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(
      `DashScope submit failed: HTTP ${submitRes.status} ${submitRes.statusText} — ${text.slice(0, 200)}`,
    );
  }
  const submitJson = asRecord(await submitRes.json());
  const taskId = asRecord(submitJson?.output)?.task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("DashScope WAN: no task_id in submit response");
  }

  const pollIntervalMs = poll?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = poll?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const pollUrl = `${base}/api/v1/tasks/${taskId}`;

  while (Date.now() < deadline) {
    const sleepMs = Math.min(
      pollIntervalMs,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    if (config.signal?.aborted) {
      throw new Error(`DashScope WAN: aborted while polling task ${taskId}`);
    }
    const res = await fetch(pollUrl, {
      headers: { authorization: `Bearer ${config.apiKey ?? ""}` },
      signal: config.signal ?? null,
    });
    if (!res.ok) continue; // transient poll errors retry on next tick
    const output = asRecord(asRecord(await res.json())?.output);
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

export const dashscopeWanWire = { id: "dashscope-wan", generate } as const;
