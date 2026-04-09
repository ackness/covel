/**
 * Plugin-local tool: example-action
 *
 * 示例工具 —— 创建新插件时请根据实际需求修改。
 * 框架会自动注入 tool 和 z，无需 import 任何依赖。
 */

export default function ({ tool, z }) {
  return tool({
    name: 'example-action',
    description: '示例工具：对指定对象执行动作。请根据实际需求修改此工具。',
    parameters: z.object({
      target: z.string().min(1).describe('操作对象名称'),
      action: z.string().min(1).describe('执行的动作描述'),
    }),
    execute: async (params, context) => {
      const result = {
        id: `${context.pluginId}-${Date.now()}`,
        target: params.target,
        action: params.action,
        timestamp: new Date().toISOString(),
      };

      return {
        success: true,
        result,
        ui: [{
          type: 'example-result',
          ...result,
        }],
      };
    },
  });
}
