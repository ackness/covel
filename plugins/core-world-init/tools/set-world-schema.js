/**
 * set-world-schema — Store character attribute schema for this world.
 * Single call to define all character attributes at once.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
export default function ({ tool, z, store }) {
  const attributeSchema = z.object({
    id: z.string().min(1).describe('属性唯一标识（如 "hp", "level", "skills"）'),
    name: z.string().min(1).describe('属性显示名称'),
    type: z.enum(['string', 'number', 'array', 'enum', 'boolean']).describe('属性数据类型'),
    min: z.number().optional().describe('数值类型最小值'),
    max: z.number().optional().describe('数值类型最大值'),
    defaultValue: z.unknown().optional().describe('默认值'),
    itemType: z.enum(['string', 'number']).optional().describe('数组元素类型（type=array 时必填）'),
    options: z.array(z.string()).optional().describe('枚举选项（type=enum 时必填）'),
    category: z.enum(['stats', 'bio', 'abilities', 'equipment', 'social']).describe('属性分类'),
    description: z.string().optional().describe('属性说明'),
  });

  return tool({
    name: 'set-world-schema',
    description: '定义世界角色属性 Schema。一次调用传入所有属性定义，无需逐个调用。至少 8 个属性。',
    parameters: z.object({
      attributes: z.array(attributeSchema).min(1).describe('角色属性定义数组'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      await store.setPluginData({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: 'schema',
        key: 'character-attributes',
        value: { version: 1, attributes: params.attributes },
        createdAt: now,
        updatedAt: now,
      });
      return {
        success: true,
        attributeCount: params.attributes.length,
        categories: [...new Set(params.attributes.map((a) => a.category))],
      };
    },
  });
}
