import { useMemo, useState } from "react";
import { Copy, Download, ExternalLink, ImageIcon, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Media } from "@/components/Media.js";
import { usePluginJobs, usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import { postPluginRpc, resolveApproval } from "@/services/api.js";
import { resolveMediaSrc } from "@/lib/media-resolve.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "@/lib/media-ref-utils.js";

interface ImageRecord {
  readonly imageId: string;
  readonly status?: string;
  readonly ref?: MediaRef;
  readonly prompt?: string;
  readonly composition?: string;
  readonly promptMode?: string;
  readonly model?: string;
  readonly imageSize?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function formatDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function statusTone(status: string | undefined): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "done") return "default";
  if (status === "pending") return "secondary";
  return "outline";
}

interface ImagePromptPayload {
  readonly prompt: string;
  readonly promptMode?: string;
  readonly composition?: string;
}

function isImageRecord(key: string, value: unknown): value is ImageRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.imageId === "string" || isMediaRef(rec.ref) || key.startsWith("img-");
}

async function triggerImageFromPrompt(
  sessionId: string | undefined,
  pluginId: string,
  payload: ImagePromptPayload,
): Promise<void> {
  if (!sessionId) throw new Error("session unavailable");
  const req = {
    pluginId,
    runtimeId: `${pluginId}/image-generator`,
    payload,
  };
  let res = await postPluginRpc(sessionId, req);
  if (res.status === "approval-required") {
    const ok = window.confirm(`Authorize ${pluginId}/image-generator for this session?`);
    await resolveApproval(res.approvalId, ok ? "allow" : "deny", "session");
    if (!ok) return;
    res = await postPluginRpc(sessionId, req);
  }
  if (res.status === "accepted") {
    emitToast("info", `已提交重抽任务：${shortId(res.jobId)}`);
    return;
  }
  if (res.status === "error") throw new Error(res.error);
  if (res.status !== "ok") return;
  const failed = res.runtimeResults?.find((r) => r.status === "failed" || r.error)?.error;
  if (failed || res.abortReason) throw new Error(failed ?? res.abortReason ?? "image generation failed");
  emitToast("info", "已提交重抽任务");
}

async function downloadRef(ref: MediaRef, sessionId: string | undefined, filename: string): Promise<void> {
  if (!sessionId) throw new Error("session unavailable");
  const resolved = await resolveMediaSrc(ref, { sessionId });
  if (!resolved.ok || !resolved.url) throw new Error("media unavailable");
  const a = document.createElement("a");
  a.href = resolved.url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function ImageGalleryPanel({ pluginId }: { pluginId: string }) {
  const { state } = useSession();
  const sessionId = state.session?.id;
  const data = usePluginNamespace(pluginId, "images");
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const images = useMemo(() => {
    const rows = Object.entries(data)
      .filter(([key, value]) => isImageRecord(key, value))
      .map(([key, value]) => ({ key, value: value as ImageRecord }));
    rows.sort((a, b) => (b.value.startedAt ?? "").localeCompare(a.value.startedAt ?? ""));
    return rows;
  }, [data]);

  if (images.length === 0) {
    return <p className="text-xs text-muted-foreground italic text-center leading-relaxed px-4 pt-6">还没有生成过图片。</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">生成结果（最新在前）。Prompt 请在「任务」页查看。</p>
      <div className="grid grid-cols-1 gap-2">
        {images.map(({ key, value }) => {
          const ref = isMediaRef(value.ref) ? value.ref : null;
          return (
            <div key={key} className="rounded-lg border border-border bg-card/60 overflow-hidden">
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => ref && setPreview(value)}
                disabled={!ref}
                title={ref ? "查看大图" : undefined}
              >
                {ref ? (
                  <Media src={ref} sessionId={sessionId ?? ""} alt={value.imageId ?? key} aspectRatio="1/1" rounded="none" fit="cover" />
                ) : (
                  <div className="aspect-square flex items-center justify-center bg-muted text-muted-foreground text-xs">
                    <ImageIcon className="w-4 h-4 mr-1" /> no image
                  </div>
                )}
              </button>
              <div className="p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 min-w-0">
                    <Badge variant={statusTone(value.status)} className="text-[9px] h-4 px-1.5">{value.status ?? "unknown"}</Badge>
                    <span className="font-mono text-[10px] text-muted-foreground truncate">{shortId(value.imageId ?? key)}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{formatDuration(value.durationMs)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {value.composition && <Badge variant="outline" className="text-[9px] h-4 px-1.5">{value.composition}</Badge>}
                  {value.model && <Badge variant="outline" className="text-[9px] h-4 px-1.5">{value.model}</Badge>}
                  {value.imageSize && <Badge variant="outline" className="text-[9px] h-4 px-1.5">{value.imageSize}</Badge>}
                </div>
                {value.error && <p className="text-[10px] text-destructive leading-relaxed line-clamp-2">{value.error}</p>}
                <div className="flex gap-1.5">
                  {ref && (
                    <>
                      <Button variant="outline" size="sm" className="h-7 px-2 text-[10px] flex-1" onClick={() => setPreview(value)}>
                        <ExternalLink className="w-3 h-3 mr-1" /> 大图
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[10px] flex-1"
                        onClick={() => {
                          void downloadRef(ref, sessionId, `${value.imageId ?? key}.png`).catch((err) =>
                            emitToast("error", err instanceof Error ? err.message : String(err)),
                          );
                        }}
                      >
                        <Download className="w-3 h-3 mr-1" /> 下载
                      </Button>
                    </>
                  )}
                  {value.prompt && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[10px] flex-1"
                      onClick={() => {
                        void triggerImageFromPrompt(sessionId, pluginId, {
                          prompt: value.prompt!,
                          promptMode: value.promptMode ?? "text",
                          composition: value.composition ?? "single-scene",
                        }).catch((err) => emitToast("error", err instanceof Error ? err.message : String(err)));
                      }}
                    >
                      重抽
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-xs">{preview?.imageId}</DialogTitle>
          </DialogHeader>
          {preview?.ref && (
            <div className="space-y-3">
              <Media src={preview.ref} sessionId={sessionId ?? ""} alt={preview.imageId ?? "image"} aspectRatio="1/1" rounded="md" fit="contain" />
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!preview?.ref) return;
                    void downloadRef(preview.ref, sessionId, `${preview.imageId}.png`).catch((err) =>
                      emitToast("error", err instanceof Error ? err.message : String(err)),
                    );
                  }}
                >
                  <Download className="w-3 h-3 mr-1" /> 下载图片
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ImageJobsPanel({ pluginId }: { pluginId: string }) {
  const { state } = useSession();
  const sessionId = state.session?.id;
  const jobs = usePluginJobs(pluginId);
  const imageData = usePluginNamespace(pluginId, "images");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const images = useMemo(() => {
    const rows = Object.entries(imageData)
      .filter(([key, value]) => isImageRecord(key, value))
      .map(([key, value]) => ({ key, value: value as ImageRecord }));
    rows.sort((a, b) => (b.value.startedAt ?? "").localeCompare(a.value.startedAt ?? ""));
    return rows;
  }, [imageData]);

  if (jobs.length === 0) {
    return <p className="text-xs text-muted-foreground italic text-center leading-relaxed px-4 pt-6">当前没有图像生成任务。</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">Prompt 与任务状态。点击任务 ID 展开详情。</p>
      {jobs.map((job) => {
        const expanded = open[job.jobId] ?? job.status === "pending";
        const output = job.runtimeResults?.[0]?.output as Record<string, unknown> | undefined;
        const triggerData = (job as unknown as { triggerEvent?: { data?: { prompt?: string; promptMode?: string; composition?: string } } }).triggerEvent?.data;
        const prompt =
          triggerData?.prompt ??
          (typeof output?.prompt === "string" ? output.prompt : "");
        const promptMode = triggerData?.promptMode ?? (typeof output?.promptMode === "string" ? output.promptMode : "text");
        const composition = triggerData?.composition ?? (typeof output?.composition === "string" ? output.composition : "single-scene");
        const linkedImages = prompt
          ? images.filter((img) => img.value.prompt === prompt)
          : [];
        return (
          <div key={job.jobId} className="rounded-lg border border-border bg-card/60">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 p-2 text-left hover:bg-muted/40"
              onClick={() => setOpen((prev) => ({ ...prev, [job.jobId]: !expanded }))}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {job.status === "pending" ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" /> : null}
                <Badge variant={statusTone(job.status)} className="text-[9px] h-4 px-1.5">{job.status}</Badge>
                <span className="font-mono text-[10px] truncate">{shortId(job.jobId)}</span>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{formatDuration(job.durationMs)}</span>
            </button>
            {expanded && (
              <div className="px-2 pb-2 space-y-2 border-t border-border/60 pt-2">
                {job.runtimeId && <p className="font-mono text-[10px] text-muted-foreground">{job.runtimeId}</p>}
                {prompt && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-muted-foreground">Prompt</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          void navigator.clipboard?.writeText(prompt);
                          emitToast("info", "Prompt 已复制");
                        }}
                      >
                        <Copy className="w-3 h-3 mr-1" /> 复制
                      </Button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap max-h-48 overflow-auto rounded bg-muted/30 p-2">{prompt}</p>
                  </div>
                )}
                {linkedImages.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-muted-foreground">
                        此 Prompt 的图片 · {linkedImages.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {linkedImages.map(({ key, value }) => {
                        const ref = isMediaRef(value.ref) ? value.ref : null;
                        return (
                          <button
                            key={key}
                            type="button"
                            className="group relative overflow-hidden rounded-md border border-border bg-muted text-left"
                            onClick={() => ref && setPreview(value)}
                            disabled={!ref}
                            title="查看大图"
                          >
                            {ref ? (
                              <Media src={ref} sessionId={sessionId ?? ""} alt={value.imageId ?? key} aspectRatio="1/1" rounded="none" fit="cover" />
                            ) : (
                              <div className="aspect-square flex items-center justify-center text-[10px] text-muted-foreground">no image</div>
                            )}
                            <span className="absolute left-1 bottom-1 rounded bg-background/85 px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                              {shortId(value.imageId ?? key)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {job.error && <p className="text-[11px] leading-relaxed text-destructive whitespace-pre-wrap">{job.error}</p>}
                {prompt && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[10px] w-full"
                    onClick={() => {
                      void triggerImageFromPrompt(sessionId, pluginId, { prompt, promptMode, composition })
                        .catch((err) => emitToast("error", err instanceof Error ? err.message : String(err)));
                    }}
                  >
                    按此 Prompt 重抽（保留原图）
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-xs">{preview?.imageId}</DialogTitle>
          </DialogHeader>
          {preview?.ref && (
            <div className="space-y-3">
              <Media src={preview.ref} sessionId={sessionId ?? ""} alt={preview.imageId ?? "image"} aspectRatio="1/1" rounded="md" fit="contain" />
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!preview?.ref) return;
                    void downloadRef(preview.ref, sessionId, `${preview.imageId}.png`).catch((err) =>
                      emitToast("error", err instanceof Error ? err.message : String(err)),
                    );
                  }}
                >
                  <Download className="w-3 h-3 mr-1" /> 下载图片
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
