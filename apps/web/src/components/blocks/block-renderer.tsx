/**
 * Block schema registry.
 *
 * 消息渲染已经全部走 json-render + plugin-data 数据流（见
 * `apps/web/src/components/session/chat-messages.tsx`）。本模块只保留一个
 * 对外契约：`setBlockSchemas(schemas)` — 供 session-store 在 boot 时注入插件
 * 声明的 blockSchemas。
 *
 * 所有自定义 React block 组件（action-guide-block / codex-entry-block / …）
 * 已被删除——插件用自己的 `ui/*.json` spec 通过 json-render 渲染。
 */

import type { BlockSchemaDeclaration } from "@covel/shared";

// Module-level mutable state: a singleton registry updated once at boot
// (via setBlockSchemas).
let blockSchemas: Record<string, BlockSchemaDeclaration> = {};

export function setBlockSchemas(
  schemas: Record<string, BlockSchemaDeclaration>,
) {
  blockSchemas = schemas;
}
