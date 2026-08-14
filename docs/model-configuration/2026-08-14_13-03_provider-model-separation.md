# Provider 与模型 ID 分离

## 目标

- 用户按“模型用途”选择服务商和模型 ID，无需理解内部 Preset。
- 同一服务商连接可维护多个模型 ID，原始 ID 原样发送给服务商。
- `openai/gpt-5.6-sol`、`deepseek/deepseek-v4-flash` 等路由型 ID 可复用底层模型能力信息。
- 模型匹配结果、来源和置信度可见；聚合服务商价格明确标为参考价格。
- 每个服务商可设置正小数价格倍率，预估结算价使用参考价乘以倍率。
- 按模型家族展示思考强度档位，并将统一设置转换为各接口协议的正确字段。
- 保持现有 `llm.customPresets`、`X-Slot-Config` 和 `llm.toml` 兼容。

## 范围

- `@covel/ai-provider` 的模型 ID 候选生成、能力匹配和模型数据库查询元数据。
- `@covel/ai-provider` 的思考强度识别及 OpenAI Chat、OpenAI Responses、Anthropic Messages 参数映射。
- Settings 的用途分配、服务商/模型管理和相关中英文文案。
- 内置 DeepSeek 默认模型、示例配置和 slot 文档。

## 假设

- model ID 是服务商 API 的不透明字符串，运行时不得改写。
- `/` 前缀可作为能力识别提示，不代表当前传输服务商。
- 能力、上下文和输入模态可从底层模型继承；聚合服务商的实际价格以其账单为准。
- 一个 provider ID 对应一个密钥命名空间；同一 provider 下的多个 model ID 共享密钥。
- 思考强度按模型 ID 中的上游命名空间优先识别，聚合服务商名称不覆盖模型家族。

## 风险

- 模糊匹配可能命中同名模型。界面展示匹配 ID，并保留手动能力覆盖。
- 老数据按单模型 Preset 保存。首次读取会生成 provider-first 配置并双写旧格式，降级仍可读取。
- DeepSeek 或聚合服务商可能调整价格。内置价格注明来源，模型数据库仍可刷新或手动覆盖。
- 各模型支持的思考档位会随版本变化；只展示已识别档位，未识别模型沿用服务商默认值且不发送猜测参数。

## 实施步骤

1. 为模型数据库增加带匹配策略的查询，并统一生成完整 ID、命名空间 ID、裸模型名候选。
2. 为能力解析增加来源与匹配元数据；API 返回完整模态、特性、价格和匹配结果。
3. 在用途分配中将服务商连接与 model ID 拆成两个控件，自动复用或生成兼容 Preset。
4. 用服务商列表 + 详情管理多个 model ID，支持每行一个 ID 的批量添加，并统一密钥、连接参数和价格倍率。
5. 重做生成参数页，同时展示默认值、当前生效值和覆盖状态。
6. 重写 Settings 中 slot/preset/provider/runtime 等面向用户的术语。
7. 更新默认配置、文档和测试。
8. 参考主流服务商与 AI SDK 的 provider options，增加服务商感知的思考强度档位和 wire 映射。

## 验证

- `openai + openai/gpt-5.6-sol` 保持原始请求 ID，并产生 `openai/gpt-5.6-sol`、`gpt-5.6-sol` 识别候选。
- `openai + deepseek/deepseek-v4-flash` 识别 DeepSeek V4 Flash 的文本输入、推理、1M 上下文和参考价格。
- 同一 provider 下两个模型可分别绑定到不同用途，切换后请求头包含正确的自定义模型方案。
- `0.1` 与 `2.5` 等倍率可持久化，成本估算按 provider + model 分组后应用倍率。
- 生成参数的默认值、当前生效值、单项恢复和整组恢复均可见。
- DeepSeek `high/max`、OpenAI `reasoning.effort`、Anthropic `output_config.effort` 和 OpenAI 兼容 `reasoning_effort` 均生成正确请求体。
- 旧 `CustomPreset[]` 导入、读取和请求头继续工作。
- 聚焦测试、相关 package 类型检查和完整 `pnpm lint` 通过。

## 回滚

恢复模型匹配函数、Settings pane、i18n 和默认 TOML 的本次提交即可；没有持久化 schema 迁移，旧数据无需回写。
