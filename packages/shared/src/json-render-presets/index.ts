export type I18nText = string | Readonly<Record<string, string>>;

export interface JsonRenderSpec {
	readonly component: string;
	readonly props?: Readonly<Record<string, unknown>>;
	readonly children?: readonly JsonRenderSpec[];
	readonly repeat?: Readonly<Record<string, unknown>>;
	readonly visible?: unknown;
	readonly on?: Readonly<Record<string, unknown>>;
}

export interface JsonRenderPanelPreset {
	readonly id: string;
	readonly group?: string;
	readonly groupLabel?: I18nText;
	readonly groupOrder?: number;
	readonly label: I18nText;
	/**
	 * Optional short label for the right-rail vertical tab strip.
	 * When provided, it is used verbatim; otherwise the framework
	 * compacts `label` (first two CJK chars / multi-word initials).
	 * Author this when the auto-truncation produces a weak token
	 * (e.g. "核心记忆" → "核心" loses the discriminating word; supply
	 * `shortLabel: { zh: "记忆", en: "Mem" }` instead).
	 */
	readonly shortLabel?: I18nText;
	readonly icon?: string;
	readonly dataSource: {
		readonly namespace: string;
	};
	readonly emptyState: {
		readonly message: I18nText;
	};
	readonly view: JsonRenderSpec;
}

export interface GalleryPresetOptions {
	readonly id?: string;
	readonly namespace?: string;
	readonly group?: string;
	readonly groupOrder?: number;
}

export interface JobsPresetOptions {
	readonly id?: string;
	readonly namespace?: string;
	readonly group?: string;
	readonly groupOrder?: number;
}

export function createGalleryPreset(
	options?: GalleryPresetOptions,
): JsonRenderPanelPreset {
	return {
		id: options?.id ?? "media-gallery",
		group: options?.group ?? "media",
		groupLabel: { zh: "媒体", en: "Media" },
		groupOrder: options?.groupOrder ?? 600,
		label: { zh: "画廊", en: "Gallery" },
		icon: "images",
		dataSource: { namespace: options?.namespace ?? "images" },
		emptyState: {
			message: {
				zh: "暂无媒体资产，生成的图片、音频或视频会显示在这里。",
				en: "No media assets yet. Generated images, audio, and video will appear here.",
			},
		},
		view: {
			component: "CardList",
			repeat: { statePath: "/entries", key: "key" },
			children: [
				{
					component: "Card",
					children: [
						{
							component: "Media",
							visible: { $item: "value/ref" },
							props: {
								ref: { $item: "value/ref" },
								alt: { $item: "value/prompt" },
								aspectRatio: "1/1",
								rounded: "md",
								fit: "cover",
							},
						},
						{
							component: "Row",
							props: { gap: "sm", align: "center", justify: "between" },
							children: [
								{
									component: "Text",
									props: {
										content: { $item: "value/prompt" },
										size: "xs",
										variant: "muted",
									},
								},
								{
									component: "Badge",
									props: {
										label: { $item: "value/status" },
										color: { $item: "value/statusColor" },
									},
								},
							],
						},
						{
							component: "Text",
							props: {
								content: { $item: "value/provider" },
								size: "xs",
								variant: "muted",
							},
						},
					],
				},
			],
		},
	};
}

export function createJobsPreset(
	options?: JobsPresetOptions,
): JsonRenderPanelPreset {
	return {
		id: options?.id ?? "background-jobs",
		group: options?.group ?? "system",
		groupLabel: { zh: "系统", en: "System" },
		groupOrder: options?.groupOrder ?? 900,
		label: { zh: "任务", en: "Jobs" },
		icon: "list-checks",
		dataSource: { namespace: options?.namespace ?? "_jobs" },
		emptyState: {
			message: {
				zh: "当前没有后台任务。",
				en: "No background jobs are running.",
			},
		},
		view: {
			component: "CardList",
			repeat: { statePath: "/entries", key: "key" },
			children: [
				{
					component: "Card",
					children: [
						{
							component: "Row",
							props: { gap: "sm", align: "center", justify: "between" },
							children: [
								{
									component: "Text",
									props: {
										content: { $item: "value/runtimeId" },
										weight: "bold",
										size: "sm",
									},
								},
								{
									component: "Badge",
									props: {
										label: { $item: "value/status" },
										color: { $item: "value/statusColor" },
									},
								},
							],
						},
						{
							component: "Text",
							props: {
								content: { $item: "key" },
								size: "xs",
								variant: "muted",
							},
						},
						{
							component: "Text",
							visible: { $item: "value/error" },
							props: {
								content: { $item: "value/error" },
								size: "xs",
								variant: "muted",
							},
						},
					],
				},
			],
		},
	};
}

export const galleryPreset = createGalleryPreset();
export const jobsPreset = createJobsPreset();
