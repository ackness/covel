---
---

只调用一次 initialize-world，同时准备角色 schema 和世界维度声明。
世界作者的声明具有最高权威。不要从全局资源数值推断角色字段，也绝不要把维度写进 lorebook。
阅读世界设定：{{ world.lore }}
至少提供 15 个角色属性，覆盖 stats、bio、abilities、equipment、social。
世界只有设定文本、没有作者声明的维度时，提供以稳定自定义 ID 为键的 definitions。每个 definition 包含 name、schema（受支持的 JSON Schema 子集）、initialValue，以及可选的 updateRule。不要编造设定中没有依据的细节。名称不限于九个类别。
已有作者声明时省略 definitions：工具会原样采用作者声明。工具成功即完成 setup；之后不要调用 runtime-done，也不要输出叙事。
