import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type DefaultTheme } from "vitepress";

// The documentation site. Pages are the Markdown files in `docs/`; this
// directory holds only the site shell. `SITE_BASE` is the path the showcase
// site is served under (see apps/site/vite.config.ts); the documentation
// lives one level below it, at `<SITE_BASE>docs/`.
const siteBase = process.env.SITE_BASE ?? "/";
const REPO_URL = "https://github.com/ackness/covel";
// VitePress puts its own base in front of a root-relative link, so the link
// back to the showcase site is its public address.
const SITE_URL = "https://covel.cc/";
const SOURCE_DIR = "docs";
// The copy of Vue that VitePress itself depends on.
const require = createRequire(import.meta.url);
const vueDir = path.dirname(
  createRequire(require.resolve("vitepress")).resolve("vue/package.json"),
);

/** The HTML elements a page may really use; any other `<name>` is text. */
const HTML_TAGS = new Set(
  "a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre s small source span strong sub summary sup table tbody td tfoot th thead tr u ul video".split(
    " ",
  ),
);

/** Pages whose body is a file included from another directory. */
const INCLUDED_FROM: Record<string, string> = {
  "en/releases.md": "docs",
};

const NOT_A_PAGE =
  /(\.en\.md|\/(README|AGENTS|CLAUDE|DOCS_STRATEGY|CONTRIBUTING|CHANGELOG)\.md|\/changelog\.d(\/.*)?|\.(json|ya?ml|ts|mjs|js))$/;

/**
 * A relative link that leaves `docs/` (a contract page not rewritten yet,
 * a source file, a bundled plugin) cannot be a page of this site. It becomes
 * a link to the same file on GitHub, so one Markdown file reads correctly
 * both on GitHub and here.
 */
function repositoryLink(href: string, relativePath: string): string | null {
  if (/^([a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return null;
  const [target = "", hash = ""] = href.split("#", 2);
  const pageDir = path.posix.join(SOURCE_DIR, path.posix.dirname(relativePath));
  // The changelog page is `docs/CHANGELOG.md` included into a page, so its
  // links are written from `docs/`.
  const linkDir = INCLUDED_FROM[relativePath] ?? pageDir;
  const resolved = path.posix.normalize(path.posix.join(linkDir, target));
  const suffix = hash ? `#${hash}` : "";
  const inSite =
    resolved === SOURCE_DIR || resolved.startsWith(`${SOURCE_DIR}/`);
  // A page of this site. The files left out of it (English editions, the
  // editors' files, data files) are read on GitHub like everything else.
  if (inSite && !NOT_A_PAGE.test(resolved)) {
    if (linkDir === pageDir) return null;
    const fromPage = path.posix.relative(pageDir, resolved);
    return `${fromPage.startsWith(".") ? "" : "./"}${fromPage}${suffix}`;
  }
  if (resolved.startsWith("..")) return null;
  const kind = path.posix.extname(resolved) ? "blob" : "tree";
  return `${REPO_URL}/${kind}/main/${resolved}${suffix}`;
}

/**
 * How the search box splits text into terms. It splits at spaces and
 * punctuation by default, which gives words in English and whole clauses in
 * Chinese, so a clause was found only by the characters it starts with
 * (`世界` found `世界包是什么`, `世界包` or `包是` found nothing).
 *
 * Both functions are sent to the browser as source text with the site data,
 * so each must stand alone (no names from this file) and be written as a
 * `function` expression, which is what its source text can be read back as.
 */
const searchTokens = {
  /**
   * Index terms. A Chinese run is indexed from every character on, each piece
   * cut at four characters (`世界包是什么` gives `世界包是`, `界包是什`,
   * `包是什么`, `是什么`, `什么`, `么`), so the prefix match finds any piece
   * of up to four characters.
   */
  index: function (text: string): string[] {
    const run =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
    const terms: string[] = [];
    let rest = 0;
    const words = (part: string) =>
      terms.push(...part.split(/[\n\r\p{Z}\p{P}]+/u).filter(Boolean));
    for (const match of text.matchAll(run)) {
      words(text.slice(rest, match.index));
      const chars = [...match[0]];
      for (let start = 0; start < chars.length; start++)
        terms.push(chars.slice(start, start + 4).join(""));
      rest = match.index + match[0].length;
    }
    words(text.slice(rest));
    return terms;
  },
  /**
   * Query terms. A Chinese run of up to four characters is one term; a longer
   * one is cut into pieces of four, since the index holds nothing longer.
   */
  query: function (text: string): string[] {
    const run =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
    const terms: string[] = [];
    let rest = 0;
    const words = (part: string) =>
      terms.push(...part.split(/[\n\r\p{Z}\p{P}]+/u).filter(Boolean));
    for (const match of text.matchAll(run)) {
      words(text.slice(rest, match.index));
      const chars = [...match[0]];
      for (let start = 0; start < chars.length; start += 4)
        terms.push(chars.slice(start, start + 4).join(""));
      rest = match.index + match[0].length;
    }
    words(text.slice(rest));
    return terms;
  },
};

/**
 * Heading anchors as GitHub makes them: lower case, spaces to hyphens, and
 * every other character that is not a letter, a digit, `-` or `_` removed.
 * With the default slugs `## POST /api/actions` would be `post-api-actions`
 * here and `post-apiactions` on GitHub, and one link could not serve both.
 */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "开始",
    items: [
      { text: "认识 Covel", link: "/start/what-is-covel" },
      { text: "安装与首次启动", link: "/start/install" },
      { text: "连接模型", link: "/start/models" },
      { text: "第一局游戏", link: "/start/first-session" },
      { text: "安装插件与世界包", link: "/start/packages" },
      { text: "数据、备份与升级", link: "/start/data-and-upgrade" },
      { text: "在公开体验站上玩", link: "/start/hosted-trial" },
      { text: "从源码运行", link: "/start/run-from-source" },
      { text: "在 Render 上部署体验站", link: "/start/deploy-render" },
    ],
  },
  {
    text: "内置插件与功能",
    items: [
      { text: "概览", link: "/builtin/" },
      { text: "叙事与记忆", link: "/builtin/story" },
      { text: "RPG 玩法", link: "/builtin/rpg" },
      { text: "角色与世界", link: "/builtin/world" },
      { text: "舞台与声音", link: "/builtin/stage" },
      { text: "应用自带的功能", link: "/builtin/features" },
    ],
  },
  {
    text: "创建世界",
    items: [
      { text: "世界包是什么", link: "/worlds/" },
      { text: "第一个世界", link: "/worlds/first-world" },
      { text: "导入 SillyTavern 内容", link: "/worlds/import-sillytavern" },
      { text: "美术方向", link: "/worlds/art-direction" },
      { text: "角色立绘", link: "/worlds/portraits" },
      { text: "场景图", link: "/worlds/scenes" },
    ],
  },
  {
    text: "开发插件",
    items: [
      { text: "插件是什么", link: "/plugins/" },
      { text: "第一个插件", link: "/plugins/first-plugin" },
      { text: "只写提示词的插件", link: "/plugins/prompt-only" },
      { text: "带代码的插件", link: "/plugins/local-code" },
      { text: "多个 runtime 与数据", link: "/plugins/advanced" },
      { text: "给插件加界面", link: "/plugins/ui" },
      { text: "写插件要知道的规则", link: "/plugins/essentials" },
      { text: "提示词写法", link: "/plugins/prompt-style" },
      { text: "深入测试", link: "/plugins/testing" },
    ],
  },
  {
    text: "验证与分发",
    items: [
      { text: "概览", link: "/ship/" },
      { text: "测试插件", link: "/ship/test" },
      { text: "打包并试装", link: "/ship/package" },
      { text: "用真实模型验证", link: "/ship/real-model" },
      { text: "发布与更新", link: "/ship/publish" },
      { text: "合集", link: "/ship/collections" },
    ],
  },
  {
    text: "常见任务",
    items: [
      { text: "概览", link: "/recipes/" },
      { text: "预置任务、物品和好感", link: "/recipes/starting-content" },
      { text: "开局配点和掷骰判定", link: "/recipes/point-buy" },
      { text: "制作和分享主题", link: "/recipes/themes" },
    ],
  },
  {
    text: "更多",
    items: [
      { text: "参考", link: "/reference/" },
      { text: "原理与维护", link: "/internals/" },
      { text: "用开发 Agent 完成任务", link: "/agent-workflow" },
      { text: "更新日志", link: "/releases" },
    ],
  },
];

const referenceSidebar: DefaultTheme.SidebarItem[] = [
  { text: "参考", items: [{ text: "概览", link: "/reference/" }] },
  {
    text: "世界",
    items: [
      { text: "世界数据", link: "/reference/world-data" },
      { text: "世界模型", link: "/reference/world-model" },
      { text: "动态维度", link: "/reference/dynamic-dimensions" },
      { text: "世界时间", link: "/reference/world-time" },
      { text: "世界包安装", link: "/reference/world-installation" },
    ],
  },
  {
    text: "插件",
    items: [
      { text: "插件字段", link: "/reference/plugins" },
      { text: "工具", link: "/reference/tools" },
      { text: "Hook", link: "/reference/hooks" },
      { text: "扩展点", link: "/reference/extension-points" },
      { text: "插件扩展与通信", link: "/reference/plugin-extensions" },
      { text: "提示词结构", link: "/reference/prompt-structure" },
      { text: "插件安装", link: "/reference/plugin-installation" },
    ],
  },
  {
    text: "字段表",
    collapsed: true,
    items: [
      { text: "总览", link: "/reference/schema/" },
      { text: "world.yaml", link: "/reference/schema/world-manifest" },
      {
        text: "world.data.yaml",
        link: "/reference/schema/world-data-descriptor",
      },
      { text: "dimensions.yaml", link: "/reference/schema/world-dimensions" },
      { text: "PLUGIN.md", link: "/reference/schema/plugin-manifest" },
      { text: "RUNTIME.md", link: "/reference/schema/runtime-manifest" },
    ],
  },
  {
    text: "界面",
    items: [
      { text: "面板", link: "/reference/ui-panels" },
      { text: "界面组件", link: "/reference/ui-components" },
      { text: "主题包", link: "/reference/theme-packages" },
      { text: "多语言", link: "/reference/i18n" },
    ],
  },
  {
    text: "模型与媒体",
    items: [
      { text: "模型用途", link: "/reference/slots" },
      { text: "评估模型", link: "/reference/evaluation" },
      { text: "图像生成", link: "/reference/image-generation" },
      { text: "媒体存储", link: "/reference/media-store" },
    ],
  },
  {
    text: "接口与配置",
    items: [
      { text: "HTTP API", link: "/reference/api" },
      { text: "SSE 协议", link: "/reference/protocol" },
      { text: "事务", link: "/reference/transactions" },
      { text: "设置存储", link: "/reference/settings-store" },
      { text: "环境变量", link: "/reference/env-registry" },
      { text: "桌面配置", link: "/reference/desktop-config" },
      { text: "术语表", link: "/reference/glossary" },
    ],
  },
];

const internalsSidebar: DefaultTheme.SidebarItem[] = [
  { text: "原理与维护", items: [{ text: "概览", link: "/internals/" }] },
  {
    text: "它怎样运转",
    items: [
      { text: "设计原则", link: "/internals/design-principles" },
      { text: "回合管线", link: "/internals/flow" },
      { text: "包的职责", link: "/internals/packages" },
      { text: "存储", link: "/internals/storage" },
      { text: "安全边界", link: "/internals/security" },
      { text: "NPC 关系图", link: "/internals/npc-graph" },
      { text: "已知的限制", link: "/internals/technical-debt" },
    ],
  },
  {
    text: "参与开发",
    items: [
      { text: "命令", link: "/internals/commands" },
      { text: "浏览器端到端测试", link: "/internals/e2e-testing" },
      { text: "桌面打包与发布", link: "/internals/desktop-packaging" },
      { text: "开发 Agent 的技能", link: "/internals/skills" },
      { text: "v0.0.42 升级指南", link: "/internals/upgrade-0.0.42" },
    ],
  },
];

const nav: DefaultTheme.NavItem[] = [
  { text: "开始", link: "/start/what-is-covel", activeMatch: "^/start/" },
  { text: "内置功能", link: "/builtin/", activeMatch: "^/builtin/" },
  { text: "创建世界", link: "/worlds/", activeMatch: "^/worlds/" },
  { text: "开发插件", link: "/plugins/", activeMatch: "^/plugins/" },
  { text: "验证与分发", link: "/ship/", activeMatch: "^/ship/" },
  { text: "常见任务", link: "/recipes/", activeMatch: "^/recipes/" },
  { text: "参考", link: "/reference/", activeMatch: "^/reference/" },
  {
    text: "更多",
    items: [
      { text: "原理与维护", link: "/internals/" },
      { text: "用开发 Agent 完成任务", link: "/agent-workflow" },
      { text: "术语表", link: "/reference/glossary" },
      { text: "更新日志", link: "/releases" },
    ],
  },
  // The showcase site, one click away from every page.
  { text: "官网", link: SITE_URL, target: "_self", noIcon: true },
];

/** English text of every navigation label. A label missing here fails the build. */
const EN: Record<string, string> = {
  开始: "Start",
  "认识 Covel": "What is Covel",
  安装与首次启动: "Install and first launch",
  连接模型: "Connect a model",
  第一局游戏: "Your first session",
  安装插件与世界包: "Install plugins and worlds",
  "数据、备份与升级": "Data, backup and upgrade",
  在公开体验站上玩: "Play on a public trial",
  从源码运行: "Run from source",
  "在 Render 上部署体验站": "Deploy a trial on Render",
  内置插件与功能: "Built-in plugins and features",
  内置功能: "Built-in",
  概览: "Overview",
  叙事与记忆: "Story and memory",
  "RPG 玩法": "RPG gameplay",
  角色与世界: "Characters and world",
  舞台与声音: "Stage and sound",
  应用自带的功能: "Features of the app",
  创建世界: "Create a world",
  世界包是什么: "What a world package is",
  第一个世界: "Your first world",
  "导入 SillyTavern 内容": "Import SillyTavern content",
  美术方向: "Art direction",
  角色立绘: "Character portraits",
  场景图: "Scene pictures",
  开发插件: "Develop a plugin",
  插件是什么: "What a plugin is",
  第一个插件: "Your first plugin",
  只写提示词的插件: "A prompt-only plugin",
  带代码的插件: "A plugin with code",
  "多个 runtime 与数据": "Several runtimes and data",
  给插件加界面: "Give a plugin an interface",
  写插件要知道的规则: "Rules every author needs",
  提示词写法: "Writing prompts",
  深入测试: "Testing in depth",
  验证与分发: "Verify and ship",
  测试插件: "Test a plugin",
  打包并试装: "Package and try installing",
  用真实模型验证: "Verify with a real model",
  发布与更新: "Publish and update",
  合集: "Collections",
  常见任务: "Recipes",
  "预置任务、物品和好感": "Starting quests, items and affinity",
  开局配点和掷骰判定: "Point-buy and dice checks",
  制作和分享主题: "Make and share a theme",
  更多: "More",
  参考: "Reference",
  原理与维护: "Internals",
  "用开发 Agent 完成任务": "Working with a coding agent",
  更新日志: "Changelog",
  术语表: "Glossary",
  官网: "Website",
  世界: "Worlds",
  世界数据: "World data",
  世界模型: "World model",
  动态维度: "Dynamic dimensions",
  世界时间: "World time",
  世界包安装: "World installation",
  插件: "Plugins",
  插件字段: "Plugin fields",
  工具: "Tools",
  Hook: "Hooks",
  扩展点: "Extension points",
  插件扩展与通信: "Plugin extensions and communication",
  提示词结构: "Prompt structure",
  插件安装: "Plugin installation",
  字段表: "Field tables",
  总览: "Index",
  "world.yaml": "world.yaml",
  "world.data.yaml": "world.data.yaml",
  "dimensions.yaml": "dimensions.yaml",
  "PLUGIN.md": "PLUGIN.md",
  "RUNTIME.md": "RUNTIME.md",
  界面: "Interface",
  面板: "Panels",
  界面组件: "UI components",
  主题包: "Theme packages",
  多语言: "Languages",
  模型与媒体: "Models and media",
  模型用途: "Model roles",
  评估模型: "Evaluation models",
  图像生成: "Image generation",
  媒体存储: "Media store",
  接口与配置: "API and configuration",
  "HTTP API": "HTTP API",
  "SSE 协议": "SSE protocol",
  事务: "Transactions",
  设置存储: "Settings store",
  环境变量: "Environment variables",
  桌面配置: "Desktop configuration",
  它怎样运转: "How it works",
  设计原则: "Design principles",
  回合管线: "Turn pipeline",
  包的职责: "Packages",
  存储: "Storage",
  安全边界: "Security boundaries",
  "NPC 关系图": "NPC graph",
  已知的限制: "Known limits",
  参与开发: "Contributing",
  命令: "Commands",
  浏览器端到端测试: "Browser end-to-end tests",
  桌面打包与发布: "Desktop packaging and release",
  "开发 Agent 的技能": "Agent skills",
  "v0.0.42 升级指南": "Upgrading to v0.0.42",
};

/** The English edition of a navigation tree: translated labels, `/en` links. */
function english<T extends { text?: string; link?: string; items?: unknown[] }>(
  items: T[],
): T[] {
  return items.map((item) => {
    const text = item.text === undefined ? undefined : EN[item.text];
    if (item.text !== undefined && text === undefined) {
      throw new Error(`No English label for "${item.text}"`);
    }
    return {
      ...item,
      text,
      link: item.link?.startsWith("/") ? `/en${item.link}` : item.link,
      activeMatch:
        "activeMatch" in item && typeof item.activeMatch === "string"
          ? item.activeMatch.replace("^/", "^/en/")
          : undefined,
      items: item.items && english(item.items as T[]),
    };
  });
}

export default defineConfig({
  srcDir: `../../${SOURCE_DIR}`,
  // The two files below are for people and agents who edit the pages.
  srcExclude: [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "DOCS_STRATEGY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "changelog.d/**",
    "**/*.en.md",
  ],
  outDir: "./dist",
  cacheDir: "./.vitepress/cache",
  base: `${siteBase}docs/`,
  lang: "zh-CN",
  title: "Covel 文档",
  description:
    "Covel 的使用与开发文档：开始游玩、创建世界、开发插件、验证与分发。",
  cleanUrls: true,
  // The tutorials name the addresses of a local dev server.
  ignoreDeadLinks: "localhostLinks",
  lastUpdated: true,
  // The pages are outside this package, so Vite would look for Vue beside
  // them, where pnpm installs nothing. Point it at VitePress's own copy.
  vite: {
    // Mermaid 12 targets Safari 17.4 / ES2024; Vite 5 otherwise lowers to Safari 14.
    build: { target: "safari17.4" },
    resolve: { alias: [{ find: /^vue(?=$|\/)/, replacement: vueDir }] },
  },
  head: [["link", { rel: "icon", href: `${siteBase}docs/icon.png` }]],

  markdown: {
    anchor: { slugify: githubSlug },
    toc: { slugify: githubSlug },
    config(md) {
      // The pages are written for GitHub, where `<locale>` in a sentence is
      // text and `{{ name }}` means nothing. Vue would read the first as an
      // element that is never closed and the second as an expression, so
      // both are turned back into text here.
      const asText = (content: string, tag: "span" | "p") =>
        `<${tag} v-pre>${md.utils.escapeHtml(content)}</${tag}>`;
      const isHtml = (content: string) => {
        const name = /^<\/?([A-Za-z][\w-]*)/.exec(content.trim())?.[1];
        return !name || HTML_TAGS.has(name.toLowerCase());
      };
      md.core.ruler.push("covel-literal-text", (state) => {
        for (const block of state.tokens) {
          if (block.type === "html_block" && !isHtml(block.content)) {
            block.content = asText(block.content.trim(), "p");
          }
          for (const token of block.children ?? []) {
            if (token.type === "html_inline" && !isHtml(token.content)) {
              token.content = asText(token.content, "span");
            } else if (token.type === "code_inline") {
              token.attrSet("v-pre", "");
            } else if (token.type === "text" && token.content.includes("{{")) {
              token.type = "html_inline";
              token.content = asText(token.content, "span");
            }
          }
        }
      });
      // A ```mermaid block becomes a diagram (theme/Mermaid.vue).
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, ...rest) => {
        const token = tokens[index]!;
        return token.info.trim() === "mermaid"
          ? `<Mermaid code="${encodeURIComponent(token.content)}" />`
          : fence(tokens, index, ...rest);
      };
      md.core.ruler.push("covel-repository-links", (state) => {
        const relativePath: unknown = state.env?.relativePath;
        if (typeof relativePath !== "string") return;
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            if (token.type !== "link_open") continue;
            const href = token.attrGet("href");
            const rewritten = href && repositoryLink(href, relativePath);
            if (rewritten) token.attrSet("href", rewritten);
          }
        }
      });
    },
  },

  locales: {
    root: { label: "简体中文", lang: "zh-CN" },
    en: {
      label: "English",
      lang: "en-US",
      title: "Covel Docs",
      description:
        "How to play Covel, create a world, develop a plugin, and verify and ship them.",
      themeConfig: {
        nav: english(nav as DefaultTheme.NavItemWithLink[]),
        sidebar: {
          "/en/reference/": english(referenceSidebar),
          "/en/internals/": english(internalsSidebar),
          "/en/": english(guideSidebar),
        },
        editLink: {
          pattern: `${REPO_URL}/edit/main/${SOURCE_DIR}/:path`,
          text: "Edit this page on GitHub",
        },
        outline: { level: [2, 3], label: "On this page" },
        docFooter: { prev: "Previous page", next: "Next page" },
        lastUpdated: { text: "Last updated" },
        returnToTopLabel: "Back to top",
        sidebarMenuLabel: "Menu",
        darkModeSwitchLabel: "Theme",
        lightModeSwitchTitle: "Switch to the light theme",
        darkModeSwitchTitle: "Switch to the dark theme",
        langMenuLabel: "Change language",
        footer: {
          message: "Released under the MIT License",
          copyright: "© 2026 Covel Contributors",
        },
      },
    },
  },
  themeConfig: {
    langMenuLabel: "切换语言",
    logo: "/icon.png",
    siteTitle: "Covel",
    nav,
    sidebar: {
      "/reference/": referenceSidebar,
      "/internals/": internalsSidebar,
      "/": guideSidebar,
    },
    socialLinks: [{ icon: "github", link: REPO_URL }],
    editLink: {
      pattern: `${REPO_URL}/edit/main/${SOURCE_DIR}/:path`,
      text: "在 GitHub 上编辑此页",
    },
    search: {
      provider: "local",
      options: {
        miniSearch: {
          options: { tokenize: searchTokens.index },
          searchOptions: { tokenize: searchTokens.query },
        },
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
              modal: {
                displayDetails: "显示详细列表",
                resetButtonTitle: "清除查询条件",
                backButtonTitle: "关闭搜索",
                noResultsText: "没有找到相关结果",
                footer: {
                  selectText: "选择",
                  navigateText: "切换",
                  closeText: "关闭",
                },
              },
            },
          },
          en: {
            translations: {
              button: { buttonText: "Search", buttonAriaLabel: "Search" },
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新于" },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "目录",
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到浅色模式",
    darkModeSwitchTitle: "切换到深色模式",
    externalLinkIcon: true,
    footer: {
      message: "基于 MIT 许可发布",
      copyright: "© 2026 Covel Contributors",
    },
  },
});
