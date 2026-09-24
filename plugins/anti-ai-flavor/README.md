# anti-ai-flavor

去除叙事正文的"AI 腔"：向 story runtime 的 system prompt 注入按会话语言选择的文风约束（说明文腔、AI 高频陈词、活人感）。纯预防，不检查生成结果。

## 运行时结构

- `PLUGIN.md`：插件清单和 15 个按条目的 `userSettings` 开关声明。
- `server/index.js`：注册 `PostContextAssembly` hook 的入口。
- `hooks/inject-style-rules.js`：hook 实现，按 `payload.locale` 分流（zh/en），只改写 `outputKind === "story"` 的 runtime。
- `hooks/_style-rules.js`：中英文两张规则表和注入文本组装，纯文本常量，无运行时状态。

## 数据与行为

- 不读写 store、不发 proposal、不调 LLM；每个回合只在上下文组装后向 system prompt 追加一次规则块。
- 关闭的条目被剔除，剩余条目跨分类连续重编号；分类下全部关闭时连标题一起省略。
- 中英文同构的规则共用开关（`banCorrectiveNegation` / `banEmDash` / `banDegreeAdverbs`），语言独有条目在另一种语言的会话里自动落空。

## 开发

修改规则文本、开关或 locale 分流后，运行本插件测试（`pnpm --filter @covel/plugin-anti-ai-flavor test`）。
