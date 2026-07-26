import type { I18nText } from "@covel/shared";

/**
 * The player-adjustable slice of the design-token system.
 *
 * The tokens themselves already exist — every theme defines them and every
 * atom in `index.css` consumes them. This table only decides which ones get a
 * control, what that control looks like, and how the value is spelled. Adding
 * a knob is a row here, not a new pipeline.
 */

export type TokenControl =
  "color" | "length" | "number" | "font" | "select" | "css";

export interface TokenOption {
  readonly value: string;
  readonly label: I18nText;
}

export interface TokenSpec {
  /** CSS custom property, leading `--` included, so it feeds setProperty directly. */
  readonly name: string;
  readonly label: I18nText;
  readonly control: TokenControl;
  /**
   * Colours read wrong when carried across light/dark, so they are stored per
   * scheme. Sizes, fonts and radii are one shared value — a player who wants
   * bigger text wants it in both schemes.
   */
  readonly perScheme?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Unit appended to numeric slider values (`length` control). */
  readonly unit?: string;
  readonly options?: readonly TokenOption[];
  readonly hint?: I18nText;
}

export interface TokenGroup {
  readonly id: string;
  readonly label: I18nText;
  readonly description: I18nText;
  readonly tokens: readonly TokenSpec[];
}

/**
 * Font stacks. The CJK entries are not decoration: this is a Chinese-first
 * narrative game, and serif/kai faces are what make long prose readable.
 *
 * Spelled out rather than pointing at `var(--font-sans)` and friends: picking
 * "serif" should give the player a serif, not silently re-inherit whatever the
 * current theme already chose.
 */
export const FONT_STACKS: readonly TokenOption[] = [
  {
    value: "Inter, ui-sans-serif, system-ui, sans-serif",
    label: { "zh-CN": "无衬线", "en-US": "Sans" },
  },
  {
    value: "Fraunces, Newsreader, ui-serif, Georgia, serif",
    label: { "zh-CN": "衬线 / 展示体", "en-US": "Serif / Display" },
  },
  {
    value: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace',
    label: { "zh-CN": "等宽", "en-US": "Monospace" },
  },
  {
    value: '"Songti SC", "Song", STSong, SimSun, "Noto Serif CJK SC", serif',
    label: { "zh-CN": "宋体", "en-US": "Songti (CJK serif)" },
  },
  {
    value: '"Kaiti SC", STKaiti, KaiTi, "Noto Serif CJK SC", serif',
    label: { "zh-CN": "楷体", "en-US": "Kaiti (CJK brush)" },
  },
  {
    value:
      '"Heiti SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    label: { "zh-CN": "黑体 / 苹方", "en-US": "Heiti / PingFang" },
  },
  {
    value: '"Yuanti SC", "Yuanti TC", "Hiragino Maru Gothic ProN", sans-serif',
    label: { "zh-CN": "圆体", "en-US": "Yuanti (rounded CJK)" },
  },
  {
    value: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    label: { "zh-CN": "系统界面字体", "en-US": "System UI" },
  },
];

const WEIGHT_OPTIONS: readonly TokenOption[] = [
  { value: "300", label: "300 · Light" },
  { value: "400", label: "400 · Regular" },
  { value: "500", label: "500 · Medium" },
  { value: "600", label: "600 · Semibold" },
  { value: "700", label: "700 · Bold" },
];

const TRANSFORM_OPTIONS: readonly TokenOption[] = [
  { value: "none", label: { "zh-CN": "原样", "en-US": "None" } },
  { value: "uppercase", label: { "zh-CN": "全大写", "en-US": "Uppercase" } },
  { value: "lowercase", label: { "zh-CN": "全小写", "en-US": "Lowercase" } },
  {
    value: "capitalize",
    label: { "zh-CN": "首字母大写", "en-US": "Capitalize" },
  },
];

/**
 * Ambience presets. `--ambience-image` accepts any CSS background image, so a
 * gradient list doubles as a "background" picker without an upload pipeline.
 * ponytail: URL + gradients only; add local-image upload when players ask —
 * data-URLs would blow the settings blob past localStorage limits.
 */
export const AMBIENCE_PRESETS: readonly TokenOption[] = [
  { value: "none", label: { "zh-CN": "无（纯色）", "en-US": "None (flat)" } },
  {
    value:
      "radial-gradient(ellipse at 80% -10%, oklch(70% 0.12 60 / 0.18), transparent 60%), radial-gradient(ellipse at -10% 110%, oklch(70% 0.10 230 / 0.14), transparent 55%)",
    label: { "zh-CN": "暖阳晕染", "en-US": "Warm wash" },
  },
  {
    value:
      "radial-gradient(ellipse at 50% -20%, oklch(60% 0.14 265 / 0.22), transparent 65%)",
    label: { "zh-CN": "夜幕辉光", "en-US": "Night glow" },
  },
  {
    value:
      "linear-gradient(160deg, oklch(65% 0.13 320 / 0.16), transparent 45%), linear-gradient(20deg, oklch(65% 0.13 200 / 0.14), transparent 50%)",
    label: { "zh-CN": "霓虹斜光", "en-US": "Neon drift" },
  },
  {
    value:
      "repeating-linear-gradient(45deg, oklch(50% 0.02 60 / 0.05) 0 2px, transparent 2px 8px)",
    label: { "zh-CN": "细纹肌理", "en-US": "Hatch texture" },
  },
];

const SHADOW_PRESETS: readonly TokenOption[] = [
  { value: "none", label: { "zh-CN": "无阴影", "en-US": "None" } },
  {
    value: "0 1px 0 var(--color-border)",
    label: { "zh-CN": "细线（印刷感）", "en-US": "Hairline" },
  },
  {
    value: "0 6px 24px -18px rgb(15 23 42 / 0.18)",
    label: { "zh-CN": "柔和浮起", "en-US": "Soft lift" },
  },
  {
    value: "0 18px 40px -24px rgb(15 23 42 / 0.35)",
    label: { "zh-CN": "强投影", "en-US": "Deep drop" },
  },
];

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: "story",
    label: { "zh-CN": "叙事正文", "en-US": "Narrative" },
    description: {
      "zh-CN": "游戏正文的排版。你在这里花的时间最多。",
      "en-US":
        "Typography of the story column — where you spend your reading time.",
    },
    tokens: [
      {
        name: "--story-font-family",
        label: { "zh-CN": "正文字体", "en-US": "Body typeface" },
        control: "font",
      },
      {
        name: "--story-font-size",
        label: { "zh-CN": "正文字号", "en-US": "Body size" },
        control: "length",
        min: 0.75,
        max: 1.6,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--story-line-height",
        label: { "zh-CN": "行高", "en-US": "Line height" },
        control: "number",
        min: 1.2,
        max: 2.4,
        step: 0.02,
      },
      {
        name: "--story-font-weight",
        label: { "zh-CN": "字重", "en-US": "Weight" },
        control: "select",
        options: WEIGHT_OPTIONS,
      },
      {
        name: "--story-letter-spacing",
        label: { "zh-CN": "字距", "en-US": "Letter spacing" },
        control: "length",
        min: -0.03,
        max: 0.2,
        step: 0.005,
        unit: "em",
      },
      {
        name: "--story-max-width",
        label: { "zh-CN": "正文栏宽", "en-US": "Column width" },
        control: "length",
        min: 28,
        max: 96,
        step: 1,
        unit: "rem",
        hint: {
          "zh-CN": "每行的最大宽度，窄栏更易读。",
          "en-US": "Maximum line length. Narrower reads easier.",
        },
      },
    ],
  },
  {
    id: "interface-type",
    label: { "zh-CN": "界面文字", "en-US": "Interface type" },
    description: {
      "zh-CN": "标题、标签与元信息的字体与字号。",
      "en-US": "Typefaces and sizes for titles, labels and metadata.",
    },
    tokens: [
      {
        name: "--font-sans",
        label: { "zh-CN": "界面基础字体", "en-US": "Base UI typeface" },
        control: "font",
        hint: {
          "zh-CN": "按钮、菜单、表单等所有界面元素。",
          "en-US": "Buttons, menus, forms — every interface element.",
        },
      },
      {
        name: "--title-font-family",
        label: { "zh-CN": "标题字体", "en-US": "Title typeface" },
        control: "font",
      },
      {
        name: "--title-font-weight",
        label: { "zh-CN": "标题字重", "en-US": "Title weight" },
        control: "select",
        options: WEIGHT_OPTIONS,
      },
      {
        name: "--title-letter-spacing",
        label: { "zh-CN": "标题字距", "en-US": "Title spacing" },
        control: "length",
        min: -0.05,
        max: 0.2,
        step: 0.005,
        unit: "em",
      },
      {
        name: "--title-text-transform",
        label: { "zh-CN": "标题大小写", "en-US": "Title case" },
        control: "select",
        options: TRANSFORM_OPTIONS,
      },
      {
        name: "--meta-font-family",
        label: { "zh-CN": "元信息字体", "en-US": "Metadata typeface" },
        control: "font",
      },
      {
        name: "--meta-font-size",
        label: { "zh-CN": "元信息字号", "en-US": "Metadata size" },
        control: "length",
        min: 0.5,
        max: 1,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--eyebrow-font-size",
        label: { "zh-CN": "眉标字号", "en-US": "Eyebrow size" },
        control: "length",
        min: 0.5,
        max: 1,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--eyebrow-letter-spacing",
        label: { "zh-CN": "眉标字距", "en-US": "Eyebrow spacing" },
        control: "length",
        min: 0,
        max: 0.4,
        step: 0.01,
        unit: "em",
      },
    ],
  },
  {
    id: "surfaces",
    label: { "zh-CN": "区域背景", "en-US": "Surfaces" },
    description: {
      "zh-CN": "界面各层的底色，从整页到单个卡片。",
      "en-US": "Background of each layer, from the page down to a single card.",
    },
    tokens: [
      {
        // The main switch: the route shell paints `bg-background` across the
        // whole viewport, so this is what a player actually sees change.
        // `--surface-page` derives from it unless a theme overrides it.
        name: "--color-background",
        label: { "zh-CN": "整体底色", "en-US": "App background" },
        control: "color",
        perScheme: true,
        hint: {
          "zh-CN": "应用的基础背景，绝大多数区域由它决定。",
          "en-US": "The base background nearly every region inherits from.",
        },
      },
      {
        name: "--surface-page",
        label: { "zh-CN": "页面底色", "en-US": "Page surface" },
        control: "color",
        perScheme: true,
        hint: {
          "zh-CN": "正文页面的底色，未单独设置时跟随整体底色。",
          "en-US":
            "The reading surface; follows the app background unless set.",
        },
      },
      {
        name: "--surface-rail",
        label: { "zh-CN": "侧栏", "en-US": "Side rails" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--surface-inset",
        label: { "zh-CN": "凹陷区块", "en-US": "Inset blocks" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--surface-elevated",
        label: { "zh-CN": "卡片 / 浮层", "en-US": "Cards" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--surface-dialog",
        label: { "zh-CN": "对话框", "en-US": "Dialogs" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--surface-player",
        label: { "zh-CN": "玩家发言", "en-US": "Player message" },
        control: "color",
        perScheme: true,
      },
    ],
  },
  {
    id: "colors",
    label: { "zh-CN": "文字与描边", "en-US": "Text & edges" },
    description: {
      "zh-CN": "正文颜色、次要文字、分隔线。",
      "en-US": "Body colour, secondary text, and dividing rules.",
    },
    tokens: [
      {
        name: "--color-foreground",
        label: { "zh-CN": "主文字", "en-US": "Primary text" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--color-muted-foreground",
        label: { "zh-CN": "次要文字", "en-US": "Muted text" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--color-primary",
        label: { "zh-CN": "主色", "en-US": "Primary" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--rule-color",
        label: { "zh-CN": "分隔线颜色", "en-US": "Rule colour" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--rule-thickness",
        label: { "zh-CN": "分隔线粗细", "en-US": "Rule thickness" },
        control: "length",
        min: 0,
        max: 4,
        step: 1,
        unit: "px",
      },
      {
        name: "--rule-style",
        label: { "zh-CN": "分隔线样式", "en-US": "Rule style" },
        control: "select",
        options: [
          { value: "solid", label: { "zh-CN": "实线", "en-US": "Solid" } },
          { value: "dashed", label: { "zh-CN": "虚线", "en-US": "Dashed" } },
          { value: "dotted", label: { "zh-CN": "点线", "en-US": "Dotted" } },
        ],
      },
    ],
  },
  {
    id: "accents",
    label: { "zh-CN": "强调色", "en-US": "Accents" },
    description: {
      "zh-CN": "状态与提示色：成功、警告、危险。",
      "en-US": "Status colours: success, warning, danger.",
    },
    tokens: [
      {
        name: "--accent-primary",
        label: { "zh-CN": "强调主色", "en-US": "Accent" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--accent-secondary",
        label: { "zh-CN": "次强调色", "en-US": "Secondary" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--accent-success",
        label: { "zh-CN": "成功", "en-US": "Success" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--accent-warning",
        label: { "zh-CN": "警告", "en-US": "Warning" },
        control: "color",
        perScheme: true,
      },
      {
        name: "--accent-danger",
        label: { "zh-CN": "危险", "en-US": "Danger" },
        control: "color",
        perScheme: true,
      },
    ],
  },
  {
    id: "ambience",
    label: { "zh-CN": "氛围背景", "en-US": "Ambience" },
    description: {
      "zh-CN": "铺满整页的背景图层与颗粒质感。",
      "en-US": "The full-page backdrop layer and its grain.",
    },
    tokens: [
      {
        name: "--ambience-image",
        label: { "zh-CN": "背景图层", "en-US": "Backdrop" },
        control: "css",
        options: AMBIENCE_PRESETS,
        hint: {
          "zh-CN":
            "可选预设，或填入任意 CSS 背景值，例如 url(https://…/bg.jpg)。",
          "en-US":
            "Pick a preset, or write any CSS background value such as url(https://…/bg.jpg).",
        },
      },
      {
        name: "--ambience-opacity",
        label: { "zh-CN": "背景强度", "en-US": "Backdrop opacity" },
        control: "number",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        name: "--ambience-blend",
        label: { "zh-CN": "混合模式", "en-US": "Blend mode" },
        control: "select",
        options: [
          { value: "normal", label: { "zh-CN": "正常", "en-US": "Normal" } },
          {
            value: "multiply",
            label: { "zh-CN": "正片叠底", "en-US": "Multiply" },
          },
          { value: "screen", label: { "zh-CN": "滤色", "en-US": "Screen" } },
          { value: "overlay", label: { "zh-CN": "叠加", "en-US": "Overlay" } },
          {
            value: "soft-light",
            label: { "zh-CN": "柔光", "en-US": "Soft light" },
          },
        ],
      },
      {
        name: "--noise-opacity",
        label: { "zh-CN": "颗粒质感", "en-US": "Grain" },
        control: "number",
        min: 0,
        max: 0.2,
        step: 0.005,
      },
    ],
  },
  {
    id: "shape",
    label: { "zh-CN": "形状与投影", "en-US": "Shape & depth" },
    description: {
      "zh-CN": "圆角大小与阴影强度。",
      "en-US": "Corner radii and shadow strength.",
    },
    tokens: [
      {
        name: "--radius-card",
        label: { "zh-CN": "卡片圆角", "en-US": "Card radius" },
        control: "length",
        min: 0,
        max: 1.5,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--radius-control",
        label: { "zh-CN": "控件圆角", "en-US": "Control radius" },
        control: "length",
        min: 0,
        max: 1.5,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--radius-dialog",
        label: { "zh-CN": "对话框圆角", "en-US": "Dialog radius" },
        control: "length",
        min: 0,
        max: 2,
        step: 0.0625,
        unit: "rem",
      },
      {
        name: "--shadow-card",
        label: { "zh-CN": "卡片阴影", "en-US": "Card shadow" },
        control: "css",
        options: SHADOW_PRESETS,
      },
    ],
  },
  {
    id: "layout",
    label: { "zh-CN": "区域尺寸", "en-US": "Layout" },
    description: {
      "zh-CN": "各个面板的宽度、高度与内边距。",
      "en-US": "Width, height and padding of each panel.",
    },
    tokens: [
      {
        name: "--rail-width-left",
        label: { "zh-CN": "左侧栏宽度", "en-US": "Left rail width" },
        control: "length",
        min: 12,
        max: 30,
        step: 0.5,
        unit: "rem",
      },
      {
        name: "--rail-width-right",
        label: { "zh-CN": "右侧栏宽度", "en-US": "Right rail width" },
        control: "length",
        min: 16,
        max: 44,
        step: 0.5,
        unit: "rem",
      },
      {
        name: "--session-column-max-width",
        label: { "zh-CN": "会话栏宽度", "en-US": "Session column width" },
        control: "length",
        min: 32,
        max: 100,
        step: 1,
        unit: "rem",
      },
      {
        name: "--composer-max-width",
        label: { "zh-CN": "输入框宽度", "en-US": "Composer width" },
        control: "length",
        min: 32,
        max: 100,
        step: 1,
        unit: "rem",
      },
      {
        name: "--panel-header-height",
        label: { "zh-CN": "面板标题高度", "en-US": "Panel header height" },
        control: "length",
        min: 2,
        max: 5,
        step: 0.125,
        unit: "rem",
      },
      {
        name: "--panel-section-padding-x",
        label: { "zh-CN": "面板横向留白", "en-US": "Panel padding X" },
        control: "length",
        min: 0,
        max: 3,
        step: 0.125,
        unit: "rem",
      },
      {
        name: "--panel-section-padding-y",
        label: { "zh-CN": "面板纵向留白", "en-US": "Panel padding Y" },
        control: "length",
        min: 0,
        max: 3,
        step: 0.125,
        unit: "rem",
      },
    ],
  },
];

const TOKEN_INDEX = new Map<string, TokenSpec>(
  TOKEN_GROUPS.flatMap((group) =>
    group.tokens.map((spec) => [spec.name, spec]),
  ),
);

export function getTokenSpec(name: string): TokenSpec | null {
  return TOKEN_INDEX.get(name) ?? null;
}

export function isAdjustableToken(name: string): boolean {
  return TOKEN_INDEX.has(name);
}

export function listAdjustableTokens(): readonly string[] {
  return [...TOKEN_INDEX.keys()];
}

/** Numeric part of a `12.5rem`-style value, or null when it is not a plain length. */
export function parseLength(value: string, unit: string): number | null {
  const match = value.trim().match(/^(-?[\d.]+)([a-z%]*)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (Number.isNaN(amount)) return null;
  // A bare `0` carries no unit but is still a valid length.
  if (match[2] && match[2].toLowerCase() !== unit.toLowerCase()) return null;
  return amount;
}

export function formatLength(amount: number, unit: string): string {
  // Trim float noise (0.30000000000000004rem) without killing real precision.
  return `${Number(amount.toFixed(4))}${amount === 0 ? "" : unit}`;
}
