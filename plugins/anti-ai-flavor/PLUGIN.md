---
name: anti-ai-flavor
displayName:
  zh: 去 AI 味
  en: Anti-AI-Flavor
description:
  zh: 给叙事正文注入三类文风约束（避免说明文写法、避免 AI 高频陈词、增强活人感），去除 LLM 的"AI 腔"。纯预防，不做写后检查。
  en: Injects three groups of prose-style constraints into story prompts (avoid expository phrasing, avoid AI-frequent clichés, add human liveliness) to strip the "AI accent". Prevention-only — never inspects generated output.
pluginType: plugin
outputKind: system
capabilities:
  - style-constraints
tags:
  - role:style
  - cost:function
entry: ./server/index.js
userSettings:
  - key: banNegation
    type: toggle
    default: true
    label:
      zh: 禁止否定描写
      en: Ban negative descriptions
    description:
      zh: 正文只写是什么、发生了什么，不通过"不是什么、没发生什么"来描写。人物对话、成语与固定搭配、内心独白除外；表现"寻求而无果"时可用否定表述，但不允许整段只有否定。仅作用于中文会话。
      en: Narration states what is and what happens, never what is not. Dialogue, idioms, and interior monologue are exempt; a fruitless search may be stated negatively, but a paragraph may not consist of negation alone. Chinese sessions only.
  - key: banCorrectiveNegation
    type: toggle
    default: true
    label:
      zh: 禁止"不是…而是…"句式
      en: Ban "not…but…" corrections
    description:
      zh: 不使用"不是……（而）是……"的先否定再纠正句式，包括把否定与纠正拆进不同句子或段落的变体；直接写是什么。
      en: No "not X but Y" negate-then-correct constructions, including variants split across sentences or paragraphs; state what is, directly.
  - key: banEmDash
    type: toggle
    default: true
    label:
      zh: 禁止破折号
      en: Ban em-dashes
    description:
      zh: 不使用破折号，表示声音拉长时除外；表达解释或转折时改用逗号。
      en: No em-dashes except for drawn-out sounds; use commas for explanation or transition instead.
  - key: banExplanatoryColon
    type: toggle
    default: true
    label:
      zh: 禁止解释性冒号
      en: Ban explanatory colons
    description:
      zh: 不使用冒号进行解释，引出人物话语的冒号不受此限；需要解释时改用逗号衔接。仅作用于中文会话。
      en: No colons used for explanation; colons introducing quoted speech are exempt. Use a comma to link an explanation instead. Chinese sessions only.
  - key: banFingerCliche
    type: toggle
    default: true
    label:
      zh: 禁止手指陈词
      en: Ban finger clichés
    description:
      zh: 不使用"指节泛白"及类似的手指描写；表现紧张、用力时改用其他身体细节。仅作用于中文会话。
      en: No "knuckles turning white" or similar finger descriptions; use other body details for tension or strain. Chinese sessions only.
  - key: banDegreeAdverbs
    type: toggle
    default: true
    label:
      zh: 减少程度副词
      en: Reduce degree adverbs
    description:
      zh: 减少"一丝""一抹""微微""淡淡""难以察觉的""极其"等程度副词与弱化修饰的使用，禁止短时间内连续出现；要写就写出具体的程度、形态或动作。
      en: Reduce hedging degree adverbs ("a trace of", "faintly", "imperceptibly", "extremely") and never stack them in quick succession; state the concrete degree, form, or action instead.
  - key: banAccountingMetaphor
    type: toggle
    default: true
    label:
      zh: 禁止账簿比喻
      en: Ban ledger metaphors
    description:
      zh: 不把"记账""算账""账目""这笔账"等账簿词汇用作抽象比喻（情绪、恩怨、因果的"账"）；真实的记账动作与真实存在的账簿不受此限。仅作用于中文会话。
      en: No ledger/bookkeeping vocabulary ("settling the score") as an abstract metaphor for feelings, grudges, or causality; actual bookkeeping acts and physical ledgers are exempt. Chinese sessions only.
  - key: banFlatVoice
    type: toggle
    default: true
    label:
      zh: 禁止无特点声音描述
      en: Ban flat voice descriptions
    description:
      zh: 不使用"声音很平""声音不大"这类无情绪、无特点的声音描述；写声音要写出质感、情绪或节奏。仅作用于中文会话。
      en: No emotionless voice descriptions such as a "flat" or "quiet" voice; describe texture, emotion, or rhythm instead. Chinese sessions only.
  - key: banVerbatimEcho
    type: toggle
    default: true
    label:
      zh: 禁止照抄复述
      en: Ban verbatim echoes
    description:
      zh: 人物对话复述前文内容时不逐字照抄原文；同样的意思也要换一种说法。仅作用于中文会话。
      en: Characters rephrase rather than quote previous text verbatim; same meaning, different wording. Chinese sessions only.
  - key: colloquialDialogue
    type: toggle
    default: true
    label:
      zh: 对话口语化
      en: Colloquial dialogue
    description:
      zh: 人物说话要口语化，不使用书面语；可以多用语气词和符合人物习惯的口癖。仅作用于中文会话。
      en: Characters speak colloquially, never in written-register language; filler words and personal verbal tics are encouraged. Chinese sessions only.
  - key: banThroatClearing
    type: toggle
    default: true
    label:
      zh: 禁止清嗓子开场
      en: Ban throat-clearing openers
    description:
      zh: 禁止"Here's the thing:"/"It turns out"/"Let that sink in."等开场铺垫与强调拐杖；直接说重点。仅作用于英文会话。
      en: No throat-clearing openers or emphasis crutches ("Here's the thing:", "It turns out", "Let that sink in.", "Make no mistake"); state the point directly. English sessions only.
  - key: banTriadicLists
    type: toggle
    default: true
    label:
      zh: 禁止三件套排比
      en: Ban triadic lists
    description:
      zh: 禁止三件式排比和为制造戏剧性堆叠的碎句（"Speed. Quality. Cost."）；节奏要有变化。仅作用于英文会话。
      en: No three-item lists or staccato fragments stacked for drama ("Speed. Quality. Cost."); vary rhythm — two items beat three. English sessions only.
  - key: banVagueDeclaratives
    type: toggle
    default: true
    label:
      zh: 禁止空洞宣告
      en: Ban vague declaratives
    description:
      zh: 禁止只宣布重要性却不点明具体内容的句子（"The stakes are high"/"The reasons are structural"）；写出具体的风险或原因。仅作用于英文会话。
      en: No vague declaratives that announce importance without naming the thing ("The stakes are high", "The reasons are structural"); name the specific stake or reason. English sessions only.
  - key: banFalseAgency
    type: toggle
    default: true
    label:
      zh: 禁止假动作主语
      en: Ban false agency
    description:
      zh: 禁止无生命事物执行人类动作（"the decision emerges"/"the data tells us"）；写出具体行动的人。仅作用于英文会话。
      en: No false agency — inanimate things do not perform human actions ("the decision emerges", "the data tells us"); name the person who acts. English sessions only.
  - key: banBusinessJargon
    type: toggle
    default: true
    label:
      zh: 禁止商业黑话
      en: Ban business jargon
    description:
      zh: 禁止商业黑话（"navigate"/"unpack"/"lean into"/"landscape"/"game-changer"/"double down"/"deep dive"）；用平实的语言。仅作用于英文会话。
      en: No business jargon ("navigate", "unpack", "lean into", "landscape", "game-changer", "double down", "deep dive"); use plain language. English sessions only.
---

# Anti-AI-Flavor

A cross-cutting, **opt-in** plugin that steers the main narrative voice away
from the LLM's "AI accent" — expository phrasing (说明文腔), clichés emitted at
abnormally high rates, and lifeless flat descriptions — through a single
lifecycle hook. It carries no schedulable runtime — its behaviour lives
entirely in the `PostContextAssembly` hook registered by its server entry
(`server/index.js`).

## How it works

| Hook                  | Role                                                                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostContextAssembly` | Once a runtime's context is assembled (after `buildContext`, before the agent loop), appends the enabled style rules to the **story** runtime's system prompt only. Story is identified by `payload.outputKind === "story"`, never by a hardcoded plugin id (isolation rule). |

The injected text (`hooks/_style-rules.js`) ships **two rule tables** picked
by `payload.locale`: zh sessions (the default zh locale and its aliases
`zh-CN` / `zh` / `zh-Hans`, mirroring the framework locale registry's
`isDefaultLocale`) get the Chinese table (破折号 / 解释性冒号 / 指节泛白);
any `en*` session gets the English table (throat-clearing / vague
declaratives / false agency). Sessions in other languages are left
byte-for-byte unchanged. Setting keys are per-rule and shared where a concept
exists in both languages (`banCorrectiveNegation` / `banEmDash` /
`banDegreeAdverbs`); a key absent from the active table is skipped silently.

**Self-contained by design.** The shipped code imports nothing outside its own
directory — community plugins load from the user plugins dir where bare
`@covel/*` specifiers do not resolve, so the zh-locale check is inlined rather
than imported from `@covel/shared`.

**Prevention-only by design.** The plugin never inspects, scores, or rewrites
generated output — the constraints live entirely in the prompt, ahead of the
text they shape. Each rule carries its own toggle; a disabled rule is omitted
from the injected block, the remaining rules are renumbered continuously, and
a category whose rules are all disabled disappears with its header.

## The three rule groups

### 1. 避免说明文写法 (expository phrasing)

| Setting (`userSettings`) | Rule (default ON)                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banNegation`            | Narration states what is / what happens, never what is not. Exemptions: dialogue, idioms, interior monologue, and "seeking without finding" beats (which still may not form a negation-only paragraph). |
| `banCorrectiveNegation`  | No "不是……（而）是……" negate-then-correct constructions, including variants split across sentences or paragraphs — state what is, never set it up with a denial. Applies everywhere, dialogue included. |
| `banEmDash`              | No em-dashes except drawn-out sounds; commas take over explanation / transition duty.                                                                                                                   |
| `banExplanatoryColon`    | No explanatory colons; colons introducing quoted speech stay legal.                                                                                                                                     |

### 2. 避免 AI 高频陈词 (AI-frequent clichés)

| Setting (`userSettings`) | Rule (default ON)                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banFingerCliche`        | No "指节泛白"-style finger clichés; tension and strain move to other body details.                                                                                      |
| `banDegreeAdverbs`       | Cut hedging degree adverbs ("一丝 / 一抹 / 微微 / 淡淡 / 难以察觉的 / 极其"), never stacked back-to-back; write the concrete degree, form, or action instead.          |
| `banAccountingMetaphor`  | No "记账 / 算账 / 账目 / 这笔账" ledger vocabulary as abstract metaphors for feelings, grudges, or causality — actual bookkeeping acts and physical ledgers are exempt. |

### 3. 增强活人感 (human liveliness)

| Setting (`userSettings`) | Rule (default ON)                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `banFlatVoice`           | No emotionless voice descriptions ("声音很平" / "声音不大"); write the voice's texture, emotion, or rhythm instead.                        |
| `banVerbatimEcho`        | Characters never quote previous narration or dialogue verbatim when recapping; the same meaning gets rephrased in the speaker's own voice. |
| `colloquialDialogue`     | Characters speak colloquially, never in written-register language; filler words (语气词) and personal verbal tics (口癖) are encouraged.    |

### English table (en sessions)

The English table reuses `banCorrectiveNegation`, `banEmDash`, and
`banDegreeAdverbs` with English rule text, and adds five en-only rules:

| Setting (`userSettings`) | Rule (default ON)                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `banThroatClearing`      | No throat-clearing openers or emphasis crutches ("Here's the thing:", "It turns out", "Let that sink in.", "Make no mistake"). |
| `banTriadicLists`        | No three-item lists or staccato fragments stacked for drama ("Speed. Quality. Cost."); vary rhythm, two items beat three.      |
| `banVagueDeclaratives`   | No vague declaratives announcing importance without naming the thing ("The stakes are high"); name the specific stake.         |
| `banFalseAgency`         | No inanimate things performing human actions ("the decision emerges", "the data tells us"); name the person who acts.          |
| `banBusinessJargon`      | No business jargon ("navigate", "unpack", "lean into", "landscape", "game-changer", "double down", "deep dive").               |

## Scope & isolation

This hook is a pure **rewrite**: it only appends to the assembled system
prompt it is handed. It never touches the store, never emits proposals, and
never calls the LLM. Enabling anti-ai-flavor for a session scopes the hook to
that session only (framework hook scoping). It is disabled by default — add
`anti-ai-flavor` to a world's plugin set or enable it per session to activate.
