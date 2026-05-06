/**
 * Built-in UI tools — generic building blocks for LLM-driven interactions.
 *
 * These are framework-level primitives. Plugins combine them via prompt
 * instructions without writing code:
 *   - char-creator calls `create-form` to build a character creation form
 *   - guide calls `create-choices` to show action options
 *   - any plugin can call `create-notification` to show alerts
 */

import { z } from "zod";
import { tool } from "../tool.js";

// ── render-ui ───────────────────────────────────────────────────

const uiPartStatusSchema = z.enum([
	"pending",
	"streaming",
	"success",
	"error",
	"paused",
]);

const uiRenderPartSchema = z.object({
	id: z.string().min(1).describe("稳定 part id"),
	type: z.string().min(1).describe("part 类型，如 text/image/audio/video/card"),
	status: uiPartStatusSchema.default("success").describe("part 独立状态"),
	content: z.unknown().describe("part 内容，由 type 决定结构"),
	retry: z
		.object({
			count: z.number().int().min(0),
			lastError: z.string().optional(),
		})
		.optional(),
});

export const renderUITool = tool({
	name: "render-ui",
	description:
		"渲染一个由多个独立 part 组成的 UI 块。每个 part 有自己的状态，适用于文本、图片、卡片、音频等多模态混排。",
	parameters: z.object({
		parts: z.array(uiRenderPartSchema).min(1).describe("UI parts 列表"),
		layout: z
			.enum(["stream", "split", "overlay"])
			.optional()
			.describe("布局方式"),
	}),
	execute: async (params) => ({
		rendered: true,
		ui: [
			{
				parts: params.parts,
				...(params.layout ? { layout: params.layout } : {}),
			},
		],
	}),
});

// ── create-form ──────────────────────────────────────────────────

const formFieldSchema = z.object({
	type: z.enum(["text", "textarea", "select", "checkbox", "number"]),
	name: z.string().min(1),
	label: z.string().min(1),
	placeholder: z.string().optional(),
	options: z.array(z.string()).optional(),
	required: z.boolean().optional(),
	defaultValue: z.string().optional(),
});

const submitBehaviorSchema = z.object({
	echoFilledNarrative: z.boolean().optional(),
	immediate: z.boolean().optional(),
});

export const createFormTool = tool({
	name: "create-form",
	description:
		"创建一个需要玩家填写的表单。框架会将表单渲染在前端，玩家填写提交后结果注入下一轮上下文（通过 `{{ player.lastFormValues }}`）。适用于角色创建、NPC 对话选择、任务确认等任何需要玩家输入的场景。表单提交后，发起表单的插件应在下一轮读取 lastFormValues 并调用相应的业务工具（如 create-character）处理。",
	parameters: z.object({
		formId: z.string().min(1).describe("表单唯一标识"),
		title: z.string().min(1).describe("表单标题"),
		fields: z.array(formFieldSchema).min(1).describe("表单字段列表"),
		submitLabel: z.string().min(1).describe("提交按钮文本"),
		narrativeTemplate: z
			.string()
			.describe(
				"叙事模板，包含 {{fieldName}} 占位符，玩家提交后由框架填充为完整叙事",
			),
		submitBehavior: submitBehaviorSchema
			.optional()
			.describe("可选的提交行为：是否回显提交内容、是否立即提交"),
	}),
	execute: async (params) => ({
		created: true,
		formId: params.formId,
		fieldCount: params.fields.length,
		interaction: {
			type: "form" as const,
			interactionId: params.formId,
			title: params.title,
			fields: params.fields,
			submitLabel: params.submitLabel,
			narrativeTemplate: params.narrativeTemplate,
			submitBehavior: params.submitBehavior,
		},
	}),
});

// ── create-choices ───────────────────────────────────────────────

const choiceSchema = z.object({
	id: z.string().min(1).describe("选项唯一标识"),
	label: z.string().min(1).describe("选项文本"),
	description: z.string().optional().describe("选项的补充说明"),
	category: z
		.string()
		.optional()
		.describe("选项分类：safe/aggressive/creative/wild 等"),
});

export const createChoicesTool = tool({
	name: "create-choices",
	description:
		"创建一个选项列表供玩家选择。适用于决策点、分支剧情、NPC 对话选项。玩家点击选项后结果注入下一轮上下文。",
	parameters: z.object({
		choiceId: z.string().min(1).describe("选项组唯一标识"),
		prompt: z.string().min(1).describe('引导文本（如"你要怎么做？"）'),
		choices: z.array(choiceSchema).min(2).describe("选项列表（至少2个）"),
	}),
	execute: async (params) => ({
		created: true,
		choiceId: params.choiceId,
		choiceCount: params.choices.length,
		interaction: {
			type: "choice" as const,
			interactionId: params.choiceId,
			prompt: params.prompt,
			choices: params.choices,
		},
	}),
});

// ── create-notification ──────────────────────────────────────────

export const createNotificationTool = tool({
	name: "create-notification",
	description:
		"在前端显示一条通知消息。适用于状态变化提醒、获得物品、触发事件等。",
	parameters: z.object({
		level: z.enum(["info", "success", "warning", "error"]).describe("通知级别"),
		title: z.string().min(1).describe("通知标题"),
		message: z.string().min(1).describe("通知内容"),
		icon: z.string().optional().describe("图标名称"),
	}),
	execute: async (params) => ({
		notified: true,
		level: params.level,
	}),
});

// ── All built-in UI tools ────────────────────────────────────────

export const builtinUITools = [
	renderUITool,
	createFormTool,
	createChoicesTool,
	createNotificationTool,
];
