/**
 * Block renderer — schema + raw fallback only.
 *
 * V1 消息渲染已经全部走 json-render + plugin-data 数据流（见
 * `apps/web/src/components/session/chat-messages.tsx`）。本模块只保留两个
 * 对外契约：
 *
 *   1. `setBlockSchemas(schemas)` / `getBlockSchemas()` — 供 session-store
 *      在 boot 时注入插件声明的 blockSchemas，schema-block-renderer 用它
 *      为没有 json-render spec 的历史 block 兜底渲染。
 *   2. `getBlockRenderer(blockType)` — 返回 schema-driven renderer（若有）
 *      或 null；不再维护硬编码的 kebab→React 组件映射。
 *
 * 所有自定义 React block 组件（action-guide-block / codex-entry-block / …）
 * 已被删除——插件用自己的 `ui/*.json` spec 通过 json-render 渲染。
 */

import { SchemaBlockRenderer } from "./schema-block-renderer.js";
import type { BlockSchemaDeclaration } from "@covel/shared";

export interface BlockRendererProps {
  data: Record<string, unknown>;
  onSubmit: (value: string) => void;
  onSelect?: (value: string) => void;
  selectedValue?: string | null;
  disabled?: boolean;
}

type BlockRendererComponent = React.ComponentType<BlockRendererProps>;

// Module-level mutable state: a singleton registry updated once at boot
// (via setBlockSchemas) and read by getBlockRenderer during render.
let blockSchemas: Record<string, BlockSchemaDeclaration> = {};

export function setBlockSchemas(schemas: Record<string, BlockSchemaDeclaration>) {
  blockSchemas = schemas;
}

export function getBlockSchemas(): Record<string, BlockSchemaDeclaration> {
  return blockSchemas;
}

/**
 * Returns a component that can render the given block type using the
 * plugin-declared schema. Returns null when no schema is registered — the
 * caller should fall back to json-render (chat-messages.tsx) or raw JSON.
 */
export function getBlockRenderer(blockType: string): BlockRendererComponent | null {
  const schema = blockSchemas[blockType];
  if (!schema) return null;

  return function SchemaBlock(props: BlockRendererProps) {
    return (
      <SchemaBlockRenderer
        schema={schema}
        data={props.data}
        onSubmit={props.onSubmit}
        disabled={props.disabled}
      />
    );
  };
}
