/**
 * set-world-schema — Store character attribute schema for this world.
 * Single call to define all character attributes at once.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
import { withPendingProposals } from '@covel/tools';

export default function ({ tool, z, store }) {
  // Recursive: an `object` attribute can carry `subSchema`, which itself is
  // an array of AttributeDefinition. Zod 4 still exposes `z.lazy(fn)` for
  // self-referential schemas; the `/** @type {z.ZodTypeAny} */` annotation
  // keeps inference happy in a plain .js file.
  /** @type {z.ZodType} */
  const attributeSchema = z.lazy(() => z.object({
    id: z.string().min(1).describe('属性唯一标识（如 "hp", "level", "skills"）'),
    name: z.string().min(1).describe('属性显示名称'),
    type: z.enum(['string', 'number', 'array', 'enum', 'boolean', 'object', 'map']).describe('属性数据类型'),
    min: z.number().optional().describe('数值类型最小值'),
    max: z.number().optional().describe('数值类型最大值'),
    defaultValue: z.unknown().optional().describe('默认值'),
    itemType: z.enum(['string', 'number']).optional().describe('数组元素类型（type=array 时必填）'),
    options: z.array(z.string()).optional().describe('枚举选项（type=enum 时必填）'),
    subSchema: z.array(attributeSchema).optional().describe('嵌套属性定义（type=object 时必填，描述对象内部结构）'),
    valueType: z.enum(['string', 'number', 'boolean']).optional().describe('map 值类型（type=map 时可选，默认 string）'),
    category: z.enum(['stats', 'bio', 'abilities', 'equipment', 'social']).describe('属性分类'),
    description: z.string().optional().describe('属性说明'),
  }));

  return tool({
    name: 'set-world-schema',
    description:
      '定义世界角色属性 Schema。一次调用传入所有属性定义。支持类型：string | number (可设 min/max/defaultValue) | boolean | enum (需 options) | array (需 itemType) | object (需 subSchema 描述子字段) | map (可选 valueType)。至少覆盖世界观文档里反复出现的核心机制。',
    parameters: z.object({
      attributes: z.array(attributeSchema).min(1).describe('角色属性定义数组'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      return withPendingProposals(
        {
          success: true,
          attributeCount: params.attributes.length,
          categories: [...new Set(params.attributes.map((a) => a.category))],
        },
        [{
          id: crypto.randomUUID(),
          type: 'plugin.data',
          source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
          turnId: context.turnId,
          sessionId: context.sessionId,
          payload: {
            namespace: 'schema',
            key: 'character-attributes',
            value: { version: 1, attributes: params.attributes },
          },
          timestamp: now,
        }],
      );
    },
  });
}
