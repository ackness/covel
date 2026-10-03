# 写维度（dimensions）

维度是世界的结构化设定和随剧情变化的数据。字段表见 `docs/reference/schema/world-dimensions.md`，完整语义见 `docs/reference/world-data.md`「动态世界维度」。本页只讲怎么写好。

## 两类维度

- **静态设定**（地理、阵营、力量体系、历史、经济、社会结构、基调、开局）：不写 `updateRule`。它只作为当前值注入叙事，不产生额外的模型调用。
- **演化数据**（声望、线索板、倒计时、阵营态度）：写 `updateRule`，用自然语言说明何时、怎样变化。规则只计本轮叙事里明确发生的事。只要有一个维度带规则，每回合就多一次维护调用（所有带规则的维度共用这一次）。

角色属性、背包、好感、任务、世界时间各有专属内容（见 `pnpm describe:authoring`），不要用维度重复记录。

## 形状

- 标量：单个值，例如一个 0–100 的整数。
- `type: object` + `properties`：固定字段的记录。
- `type: array` + object `items`：一组同构的行。
- `additionalProperties: <schema>`：动态命名的记录，例如按线索 ID 存放的线索板。
- 枚举用稳定的英文值，显示名写在 `x-enumLabels`。
- 需要多语言的文本节点标 `x-i18n: true`，值写成 `{zh-CN: …, en-US: …}`；没有标的节点不会被当作翻译。

schema 只支持 `docs/reference/world-data.md` 列出的 JSON Schema 子集，写了不支持的关键字会直接报错。

## 示例

下面这段会在 CI 里按生产 schema 校验，可以照抄结构。

```yaml
# data/dimensions.yaml
geography:
  name: 地理
  schema:
    type: object
    properties:
      overview: { type: string }
      regions:
        type: array
        minItems: 1
        items:
          type: object
          properties:
            name: { type: string }
            description: { type: string }
          required: [name, description]
          additionalProperties: false
    required: [regions]
    additionalProperties: false
  initialValue:
    overview: 终年被雾笼罩的港城，潮水退去时露出旧城遗迹。
    regions:
      - name: 主栈桥
        description: 公会与议会所在的上城码头。
      - name: 下潮区
        description: 只在退潮时露出的遗迹带。
      - name: 盐牙巷
        description: 走私者与线人聚集的窄巷。

reputation:
  name: 声望
  description: 主角在港城的公开声望。
  schema: { type: integer, minimum: 0, maximum: 100 }
  initialValue: 10
  updateRule: 公开完成居民的委托后加 5；公开背信减 10。只计已完成的行为，不计承诺。

caseBoard:
  name: 案情板
  description: 已发现线索及其可信度。
  schema:
    type: object
    additionalProperties:
      type: object
      properties:
        lead: { type: string }
        status:
          type: string
          enum: [unverified, corroborated, resolved]
          x-enumLabels:
            unverified: 未核实
            corroborated: 已佐证
            resolved: 已解决
      required: [lead, status]
      additionalProperties: false
  initialValue:
    torn-letter:
      lead: 半封被撕开的信
      status: unverified
  updateRule: 发现新的具名物证或证词时新增一条，状态为 unverified；有独立证词印证时改为 corroborated；真相确认后改为 resolved。不删除条目。
```

## 内容要求

- 至少 3 个地区、3 个阵营、4 个力量等级、3 个历史事件、3 个社会阶层。
- 开局场景要有即时的选择或紧张感。
- 维度 ID 以小写字母开头，用字母、数字、`_`、`-`。
- 维度越贴合主线，依赖维度的内容（例如隐藏剧情的触发条件）就越扎实。
