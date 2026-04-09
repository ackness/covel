/**
 * {{pluginName}} 插件测试
 *
 * 测试内容：
 * 1. 工具基本功能
 * 2. 参数验证
 * 3. 返回结构正确性
 */

import { describe, it, expect } from 'vitest';
import { tool, z } from '@covel/tools';
import createExampleAction from '../tools/example.js';

// 通过工厂函数创建工具实例（框架在运行时自动完成，测试中需手动调用）
const exampleActionTool = createExampleAction({ tool, z });

const ctx = {
  sessionId: 'sess-test',
  turnId: 'turn-1',
  pluginId: '{{pluginName}}',
  runtimeId: '{{pluginName}}',
};

describe('example-action tool', () => {
  it('应该成功执行并返回结果', async () => {
    const result = await exampleActionTool.execute({
      target: '宝箱',
      action: '打开',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.result.target).toBe('宝箱');
    expect(result.result.action).toBe('打开');
    expect(result.result.id).toBeDefined();
    expect(result.result.timestamp).toBeDefined();
  });

  it('应该生成 UI 卡片', async () => {
    const result = await exampleActionTool.execute({
      target: '石门',
      action: '推开',
    }, ctx);

    expect(result.ui).toHaveLength(1);
    expect(result.ui[0].type).toBe('example-result');
    expect(result.ui[0].target).toBe('石门');
  });
});
