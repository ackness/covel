import { instructionLocaleFor } from "@covel/plugin-handlers-utils";

// Compare JSON values independently of object key order; array order is semantic.
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

/** Final submission must preserve the public result already validated by our tool. */
export default function reviewOutput(ctx, payload) {
  if (ctx.runtimeId !== "world-ir") return { action: "continue" };
  let canonical;
  for (const result of payload.toolResults) {
    if (result.toolName !== "submit-world-facts") continue;
    let value;
    try {
      value =
        typeof result.output === "string"
          ? JSON.parse(result.output)
          : result.output;
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || value.error) continue;
    canonical = value;
  }

  if (
    canonical &&
    JSON.stringify(ordered(payload.output)) ===
      JSON.stringify(ordered(canonical))
  )
    return { action: "continue" };
  return {
    action: "continue",
    replace: {
      correction:
        instructionLocaleFor(ctx.locale) === "zh"
          ? "请用 `submit-output` 原样提交 `submit-world-facts` 最近一次成功返回的规范结果。不要重复业务调用；只修正最终提交。"
          : "Use `submit-output` to submit the canonical result of the latest successful `submit-world-facts` call unchanged. Do not repeat the business call; correct only the final submission.",
    },
  };
}
