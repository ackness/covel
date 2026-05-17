/**
 * @covel/plugin-{{pluginName}} — note handler
 *
 * Manual function runtime for deterministic plugin-owned state updates.
 * The sidebar may pass ctx.manualPayload, but the fallback keeps the template
 * usable immediately after scaffolding.
 */

const NOTES_NAMESPACE = "notes";

export default async function noteHandler(ctx) {
  const { pluginData, logger, manualPayload, turnId } = ctx;

  if (!pluginData || typeof pluginData.set !== "function") {
    return {
      status: "failed",
      error: "ctx.pluginData.set is unavailable. Upgrade @covel/runtime.",
    };
  }

  const payload = isRecord(manualPayload) ? manualPayload : {};
  const title = stringValue(payload.title) ?? "Manual checkpoint";
  const text =
    stringValue(payload.text) ??
    "Replace this placeholder note with plugin-specific state.";
  const tags = stringArray(payload.tags);
  const createdAt = new Date().toISOString();
  const key = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const record = {
    id: key,
    kind: "manual",
    title,
    text,
    tags,
    turnId,
    createdAt,
  };

  await pluginData.set(NOTES_NAMESPACE, key, record);
  await logger?.info?.("note.recorded", { key, title });

  return { status: "ok", note: record };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
}
