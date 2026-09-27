import { randomUUID } from "node:crypto";

const CONTRACT = "examples/note-format@1";
const SERVICE_NAME = "format-note";

function error(ctx, zh, en) {
  return new Error(ctx.locale?.startsWith("zh") ? zh : en);
}

export default async function save(ctx) {
  const payload = ctx.manualPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw error(ctx, "请输入记录内容。", "Enter note text.");
  }
  const originalText = payload.text;
  if (
    typeof originalText !== "string" ||
    !originalText.trim() ||
    originalText.length > 4000
  ) {
    throw error(
      ctx,
      "记录内容须为 1 至 4000 个字符，且不能全为空白。",
      "Note text must contain nonblank text and be at most 4000 characters.",
    );
  }

  const selected = payload.providerPluginId;
  if (selected !== undefined && typeof selected !== "string") {
    throw error(ctx, "格式化插件 ID 无效。", "Invalid formatter plugin ID.");
  }
  const providerPluginId = selected?.trim() || null;
  let text = originalText;
  if (providerPluginId !== null) {
    const providers = await ctx.services.discover(CONTRACT);
    if (
      !providers.some(
        (service) =>
          service.pluginId === providerPluginId &&
          service.name === SERVICE_NAME,
      )
    ) {
      throw error(
        ctx,
        "所选记录格式化插件当前不可用。",
        "The selected note formatter is unavailable.",
      );
    }
    let result;
    try {
      result = await ctx.services.call(
        {
          pluginId: providerPluginId,
          name: SERVICE_NAME,
          contract: CONTRACT,
          input: { text: originalText },
        },
        { timeoutMs: 1500, signal: ctx.signal },
      );
    } catch {
      throw error(
        ctx,
        "记录格式化失败，请重试或选择保存原文。",
        "Note formatting failed. Retry or save the original text.",
      );
    }
    text = result?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 8000) {
      throw error(
        ctx,
        "格式化结果无效或超过 8000 个字符。",
        "The formatted note is blank, invalid, or exceeds 8000 characters.",
      );
    }
  }

  const note = {
    id: randomUUID(),
    originalText,
    text,
    providerPluginId,
    createdAt: new Date().toISOString(),
  };
  await ctx.pluginData.set("notes", note.id, note);
  return { outcome: "success", value: { note } };
}
