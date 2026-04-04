/**
 * Pure business logic for story image generation.
 * All functions are immutable — they return new state objects.
 */

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
}

export const EMPTY_STATE: ImageState = {
  recentImages: [],
  maxHistory: 20,
};

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

const SEQUENCING_PATTERN_SOURCE =
  /(?:first|then|next|finally|afterward|subsequently|接着|随后|然后|最后|紧接着)/i;

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

  const sequenceMatches = text.match(new RegExp(SEQUENCING_PATTERN_SOURCE.source, "gi"));
  if (sequenceMatches && sequenceMatches.length >= 2) {
    return { isMultiScene: true, reason: "sequential cues" };
  }

  return { isMultiScene: false };
}

// ── Prompt Building ────────────────────────────────────────────

/**
 * Build the system prompt for Step 1 LLM enhancement.
 * Instructs the LLM to act as a professional image prompt engineer.
 */
export function buildEnhancePrompt(
  request: ImageRequest,
  worldContext?: string,
  characters?: string,
): string {
  const style = request.stylePreset ?? "cinematic";
  const layout = request.layoutPreference ?? "auto";

  const parts: string[] = [
    "You are a professional image generation prompt engineer.",
    "Transform the following scene description into an optimized image prompt.",
    "",
    `Style preset: ${style}`,
    `Layout preference: ${layout}`,
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
    parts.push(
      "",
      "## Visual Continuity Notes",
      request.continuityNotes,
    );
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
    "- Return ONLY the enhanced prompt, no explanations",
  );

  return parts.join("\n");
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
