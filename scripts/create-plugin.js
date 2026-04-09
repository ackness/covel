#!/usr/bin/env node

/**
 * Covel 插件脚手架脚本
 *
 * 用法：
 *   node scripts/create-plugin.js <plugin-name>              # 创建最小插件
 *   node scripts/create-plugin.js <plugin-name> --with-tools # 创建带工具的插件
 *
 * 示例：
 *   node scripts/create-plugin.js my-awesome-plugin
 *   node scripts/create-plugin.js my-awesome-plugin --with-tools
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ── 参数解析 ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const withTools = args.includes('--with-tools');
const pluginName = args.find((a) => !a.startsWith('--'));

if (!pluginName) {
  console.error('错误：请提供插件名称。\n');
  console.error('用法：');
  console.error('  node scripts/create-plugin.js <plugin-name>');
  console.error('  node scripts/create-plugin.js <plugin-name> --with-tools\n');
  console.error('示例：');
  console.error('  node scripts/create-plugin.js my-awesome-plugin');
  console.error('  node scripts/create-plugin.js my-awesome-plugin --with-tools');
  process.exit(1);
}

// 验证插件名称格式
if (!/^[a-z][a-z0-9-]*$/.test(pluginName)) {
  console.error('错误：插件名称只能包含小写字母、数字和连字符，且必须以字母开头。');
  console.error(`  收到：${pluginName}`);
  process.exit(1);
}

const targetDir = resolve(ROOT, 'plugins', pluginName);

if (existsSync(targetDir)) {
  console.error(`错误：目录已存在 → plugins/${pluginName}/`);
  console.error('请选择其他名称或先删除已有目录。');
  process.exit(1);
}

// ── 模板选择 ──────────────────────────────────────────────────────

const templateName = withTools ? 'plugin-with-tools' : 'plugin-minimal';
const templateDir = resolve(ROOT, 'templates', templateName);

if (!existsSync(templateDir)) {
  console.error(`错误：找不到模板目录 → templates/${templateName}/`);
  process.exit(1);
}

// ── 占位符替换 ────────────────────────────────────────────────────

const placeholders = {
  '{{pluginName}}': pluginName,
  '{{pluginDescription}}': `${pluginName} 插件 —— 请在此填写插件描述。`,
};

/**
 * 替换文件内容中的占位符
 * @param {string} content
 * @returns {string}
 */
function replacePlaceholders(content) {
  let result = content;
  for (const [placeholder, value] of Object.entries(placeholders)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

// ── 递归复制目录 ──────────────────────────────────────────────────

/**
 * 递归复制目录，同时替换文件内容中的占位符
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src);
  for (const entry of entries) {
    // 跳过 node_modules
    if (entry === 'node_modules') continue;

    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, replacePlaceholders(content), 'utf-8');
    }
  }
}

// ── 执行 ──────────────────────────────────────────────────────────

console.log(`\n正在创建插件：${pluginName}`);
console.log(`模板：${templateName}\n`);

copyDir(templateDir, targetDir);

// 列出生成的文件
console.log('已生成文件：');

function listFiles(dir, prefix = '') {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    const rel = relative(ROOT, fullPath);
    if (stat.isDirectory()) {
      listFiles(fullPath, prefix);
    } else {
      console.log(`  ${rel}`);
    }
  }
}

listFiles(targetDir);

// ── 提示下一步操作 ────────────────────────────────────────────────

console.log('\n下一步：');
console.log(`  1. 编辑 plugins/${pluginName}/PLUGIN.md，填写插件的 LLM 提示词`);

if (withTools) {
  console.log(`  2. 修改 plugins/${pluginName}/tools/example.js，实现你的工具逻辑`);
  console.log(`  3. 更新 plugins/${pluginName}/tests/example.test.js，编写测试`);
  console.log(`  4. 运行 cd plugins/${pluginName} && pnpm install && pnpm test`);
} else {
  console.log('  2. 如需添加工具，可用 --with-tools 标志重新生成');
}

console.log(`\n插件创建完成！路径：plugins/${pluginName}/\n`);
