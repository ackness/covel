/**
 * Pure business logic for story image generation.
 * All functions are immutable — they return new state objects.
 */

// ── Settings ───────────────────────────────────────────────────

export interface ImageSettings {
  readonly style: "cinematic" | "anime" | "oil-painting" | "watercolor" | "pixel-art" | "photoreal";
  readonly multiPanel: boolean;
  readonly includeText: boolean;
  readonly promptLanguage: "auto" | "zh" | "en";
}

export const DEFAULT_SETTINGS: ImageSettings = {
  style: "cinematic",
  multiPanel: false,
  includeText: false,
  promptLanguage: "auto",
};

// ── Data Structures ────────────────────────────────────────────

export interface ImageRequest {
  readonly storyBackground: string;
  readonly scenePrompt: string;
  readonly continuityNotes?: string;
  readonly layoutPreference?: "single" | "comic" | "auto";
  readonly stylePreset?: string;
  readonly negativePrompt?: string;
}

export interface EnhancedPrompt {
  readonly original: string;
  readonly enhanced: string;
  readonly isMultiScene: boolean;
  readonly multiSceneReason?: string;
}

export interface ImageResult {
  readonly imageId: string;
  readonly prompt: EnhancedPrompt;
  readonly status: "generating" | "ready" | "error";
  readonly imageUrl?: string;
  readonly error?: string;
  readonly stylePreset: string;
  readonly createdAt: string;
}

export interface ImageState {
  readonly recentImages: readonly ImageResult[];
  readonly maxHistory: number;
  readonly settings: ImageSettings;
}

export const EMPTY_STATE: ImageState = {
  recentImages: [],
  maxHistory: 20,
  settings: DEFAULT_SETTINGS,
};

// ── Prompt Language Resolution ─────────────────────────────────

/**
 * Resolve the final prompt language based on settings and session locale.
 * "auto" follows session locale (zh-* → zh, otherwise en).
 */
export function resolvePromptLanguage(
  settings: ImageSettings,
  locale: string,
): "zh" | "en" {
  if (settings.promptLanguage === "zh") return "zh";
  if (settings.promptLanguage === "en") return "en";
  return locale.startsWith("zh") ? "zh" : "en";
}

// ── Multi-Scene Detection ──────────────────────────────────────

const MULTI_SCENE_KEYWORDS_ZH = [
  "多场景",
  "分镜",
  "切换",
  "与此同时",
  "同一时间",
  "另一边",
  "前后对比",
  "画面切换",
  "场景转换",
];

const MULTI_SCENE_KEYWORDS_EN = [
  "meanwhile",
  "at the same time",
  "scene_frames",
  "scene transition",
  "cut to",
  "split screen",
  "before and after",
  "on the other side",
  "intercut",
];

const DIALOGUE_PATTERN = /["「『].*?["」』].*?["「『].*?["」』]/s;

const SEQUENCING_PATTERN =
  /(?:first|then|next|finally|afterward|subsequently|接着|随后|然后|最后|紧接着)/gi;

/**
 * Heuristic detection of multi-panel layouts based on text content.
 */
export function detectMultiScene(
  text: string,
): { readonly isMultiScene: boolean; readonly reason?: string } {
  const lower = text.toLowerCase();

  for (const kw of MULTI_SCENE_KEYWORDS_ZH) {
    if (lower.includes(kw)) {
      return { isMultiScene: true, reason: `keyword: ${kw}` };
    }
  }

  for (const kw of MULTI_SCENE_KEYWORDS_EN) {
    if (lower.includes(kw)) {
      return { isMultiScene: true, reason: `keyword: ${kw}` };
    }
  }

  if (DIALOGUE_PATTERN.test(text)) {
    return { isMultiScene: true, reason: "dialogue pattern" };
  }

  SEQUENCING_PATTERN.lastIndex = 0; // reset global regex state before each use
  const sequenceMatches = text.match(SEQUENCING_PATTERN);
  if (sequenceMatches && sequenceMatches.length >= 2) {
    return { isMultiScene: true, reason: "sequential cues" };
  }

  return { isMultiScene: false };
}

// ── Prompt Building ────────────────────────────────────────────

/**
 * Build the English enhancement prompt for Step 1 LLM.
 * Optimized for models that perform better in English (GPT, Gemini, etc.).
 */
export function buildEnhancePromptEn(
  request: ImageRequest,
  worldContext?: string,
  characters?: string,
  settings?: ImageSettings,
): string {
  const style = settings?.style ?? request.stylePreset ?? "cinematic";
  const layout = request.layoutPreference ?? (settings?.multiPanel ? "comic" : "auto");
  const includeText = settings?.includeText ?? false; // default: no text in image

  const parts: string[] = [
    "You are a professional image generation prompt engineer for a story illustration system.",
    "Transform the following scene description into an optimized image generation prompt.",
    "",
    `Style: ${style}`,
    `Layout: ${layout}`,
    ...(includeText ? [] : ["No text in image — avoid all text, labels, captions, and watermarks"]),
    ...(settings?.multiPanel ? ["Output format: multi-panel comic layout"] : []),
    "",
    "## Story Background",
    request.storyBackground,
    "",
    "## Scene to Illustrate",
    request.scenePrompt,
  ];

  if (worldContext) {
    parts.push("", "## World Context", worldContext);
  }

  if (characters) {
    parts.push("", "## Characters Present", characters);
  }

  if (request.continuityNotes) {
    parts.push("", "## Visual Continuity Notes", request.continuityNotes);
  }

  if (request.negativePrompt) {
    parts.push("", "## Negative Prompt (avoid these)", request.negativePrompt);
  }

  parts.push(
    "",
    "## Instructions",
    "- Output 60-120 words for single scene, 80-200 for multi-panel",
    "- Use concrete visual details: lighting, colors, composition, camera angle",
    `- Apply ${style} style naturally`,
    "- If multi-scene detected, prefix with [MULTI-SCENE]",
    "- Return ONLY the prompt, no explanations",
  );

  return parts.join("\n");
}

/**
 * Build the Chinese enhancement prompt for Step 1 LLM.
 * Optimized for models that perform better in Chinese (DashScope WAN, Qwen, etc.).
 */
export function buildEnhancePromptZh(
  request: ImageRequest,
  worldContext?: string,
  characters?: string,
  settings?: ImageSettings,
): string {
  const style = settings?.style ?? request.stylePreset ?? "cinematic";
  const styleZh: Record<string, string> = {
    cinematic: "电影感",
    anime: "动漫风格",
    "oil-painting": "油画风格",
    watercolor: "水彩风格",
    "pixel-art": "像素艺术",
    photoreal: "超写实摄影",
  };
  const styleLabel = styleZh[style] ?? style;
  const includeText = settings?.includeText ?? false; // default: no text in image
  const multiPanel = settings?.multiPanel ?? false;

  const parts: string[] = [
    "你是一名专业的故事插画图像生成提示词工程师。",
    "请将以下场景描述转化为优化的图像生成提示词。",
    "",
    `画面风格：${styleLabel}`,
    ...(multiPanel ? ["画面格式：多格漫画分镜"] : ["画面格式：单幅插画"]),
    ...(includeText ? [] : ["文字要求：画面中不包含任何文字、标签或说明"]),
    "",
    "## 故事背景",
    request.storyBackground,
    "",
    "## 需要描绘的场景",
    request.scenePrompt,
  ];

  if (worldContext) {
    parts.push("", "## 世界观与场景信息", worldContext);
  }

  if (characters) {
    parts.push("", "## 在场角色", characters);
  }

  if (request.continuityNotes) {
    parts.push("", "## 视觉连贯性说明", request.continuityNotes);
  }

  if (request.negativePrompt) {
    parts.push("", "## 负向提示词（需要避免的内容）", request.negativePrompt);
  }

  parts.push(
    "",
    "## 输出要求",
    "- 单幅插画：60-120字；多格分镜：80-200字",
    "- 使用具体的视觉细节：光线、色调、构图、镜头角度",
    `- 自然融入${styleLabel}风格`,
    "- 如需多格分镜，以[MULTI-SCENE]开头",
    "- 只输出提示词，不需要任何解释",
  );

  return parts.join("\n");
}

/**
 * Build prompt in the resolved language. (backward compat wrapper)
 */
export function buildEnhancePrompt(
  request: ImageRequest,
  worldContext?: string,
  characters?: string,
  settings?: ImageSettings,
  locale?: string,
): string {
  const lang = resolvePromptLanguage(settings ?? DEFAULT_SETTINGS, locale ?? "zh-CN");
  return lang === "zh"
    ? buildEnhancePromptZh(request, worldContext, characters, settings)
    : buildEnhancePromptEn(request, worldContext, characters, settings);
}

// ── State Management ───────────────────────────────────────────

/**
 * Add an image result to state, trimming to maxHistory. Immutable.
 */
export function addImageResult(
  state: ImageState,
  result: ImageResult,
): ImageState {
  const updated = [result, ...state.recentImages];
  const trimmed = updated.slice(0, state.maxHistory);
  return { ...state, recentImages: trimmed };
}

/**
 * Build a human-readable summary of recent images for context injection.
 */
export function getRecentImageSummary(
  state: ImageState,
  locale: string,
  limit: number = 5,
): string {
  const isZh = locale.startsWith("zh");

  if (state.recentImages.length === 0) {
    return isZh ? "暂无已生成的插画。" : "No images generated yet.";
  }

  const items = state.recentImages.slice(0, limit);
  const lines: string[] = [
    isZh ? "## 最近生成的插画" : "## Recent Images",
  ];

  for (const img of items) {
    const statusLabel = isZh
      ? { generating: "生成中", ready: "已完成", error: "失败" }[img.status]
      : img.status;

    const sceneType = img.prompt.isMultiScene
      ? (isZh ? "多分镜" : "multi-scene")
      : (isZh ? "单场景" : "single");

    lines.push(
      `- [${statusLabel}][${sceneType}][${img.stylePreset}] ${img.prompt.original.slice(0, 60)}...`,
    );
  }

  return lines.join("\n");
}

/**
 * Extract world context summary for prompt building.
 * Collects world lore + dimensions into a single string.
 */
export function extractWorldContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;

  const ctx = context as Record<string, unknown>;
  const world = ctx.world as Record<string, unknown> | undefined;
  if (!world) return undefined;

  const parts: string[] = [];

  if (typeof world.lore === "string") {
    parts.push(world.lore.slice(0, 1000));
  } else if (world.lore && typeof world.lore === "object") {
    const loreRecord = world.lore as Record<string, string>;
    const firstLore = Object.values(loreRecord)[0];
    if (firstLore) parts.push(firstLore.slice(0, 1000));
  }

  const dimensions = world.dimensions as Record<string, unknown> | undefined;
  if (dimensions) {
    // Cap at 5 dimensions to avoid exhausting the enhancement LLM's token budget
    const dimensionEntries = Object.entries(dimensions).slice(0, 5);
    for (const [key, val] of dimensionEntries) {
      if (typeof val === "string" && val.length > 0) {
        parts.push(`${key}: ${val.slice(0, 300)}`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Extract character summaries for prompt building.
 */
export function extractCharacterContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;

  const ctx = context as Record<string, unknown>;
  const characters = ctx.characters as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(characters) || characters.length === 0) return undefined;

  const summaries = characters
    .slice(0, 5)
    .map((c) => {
      const name = c.name ?? c.id ?? "Unknown";
      const desc = c.description ?? c.appearance ?? "";
      return `${name}${desc ? `: ${String(desc).slice(0, 100)}` : ""}`;
    });

  return summaries.join("\n");
}
