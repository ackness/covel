import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInView } from "@/hooks/use-in-view";
import { useI18nResolver } from "@/lib/catalog";

/**
 * Marketing tile descriptor. Only the visual layout (`span`) and the
 * `capability` slot are framework-owned. The plugin's display name and blurb
 * are read from the plugin's manifest at fetch time so the framework never
 * hardcodes plugin-specific copy or i18n keys (framework/plugin isolation rule).
 *
 * `bandKey` describes the *capability tier* shown above the card (e.g.
 * "Narrator · 500", "After-Turn"), not the plugin itself — keeping it as a
 * framework i18n key is intentional.
 */
interface Tile {
	key: string;
	capability: string;
	bandKey: string;
	bandFallback: string;
	span: string;
}

const TILES: readonly Tile[] = [
	{
		key: "narrator",
		capability: "narrative",
		bandKey: "home.plugins.narratorBand",
		bandFallback: "Narrator · 500",
		span: "md:col-span-3 md:row-span-2",
	},
	{
		key: "world-init",
		capability: "world-data-provider",
		bandKey: "home.plugins.worldInitBand",
		bandFallback: "Pre-Game · 0–99",
		span: "md:col-span-2 md:row-span-1",
	},
	{
		key: "image",
		capability: "image-generation",
		bandKey: "home.plugins.imageBand",
		bandFallback: "After-Turn · 700",
		span: "md:col-span-2 md:row-span-1",
	},
	{
		key: "memory",
		capability: "memory-panel",
		bandKey: "home.plugins.memoryBand",
		bandFallback: "Audit · 1000",
		span: "md:col-span-2 md:row-span-1",
	},
	{
		key: "rules",
		capability: "rules-engine",
		bandKey: "home.plugins.rulesBand",
		bandFallback: "Pre-Turn · 200",
		span: "md:col-span-2 md:row-span-1",
	},
	{
		key: "characters",
		capability: "character-management",
		bandKey: "home.plugins.charactersBand",
		bandFallback: "After-Turn · 600",
		span: "md:col-span-3 md:row-span-1",
	},
];

interface RegistryPlugin {
	id: string;
	name?: unknown;
	description?: unknown;
	capabilities?: string[];
	source?: "builtin" | "official" | "community";
}

interface PluginMatch {
	id: string;
	name?: unknown;
	description?: unknown;
}

const SOURCE_RANK: Record<NonNullable<RegistryPlugin["source"]>, number> = {
	builtin: 0,
	official: 1,
	community: 2,
};

/**
 * Resolve `capability → first matching plugin`, preferring builtin over
 * official over community when multiple plugins claim the same capability.
 */
function indexByCapability(
	plugins: readonly RegistryPlugin[],
): Map<string, PluginMatch> {
	const sorted = [...plugins].sort(
		(a, b) =>
			(SOURCE_RANK[a.source ?? "community"] ?? 3) -
			(SOURCE_RANK[b.source ?? "community"] ?? 3),
	);
	const index = new Map<string, PluginMatch>();
	for (const p of sorted) {
		for (const cap of p.capabilities ?? []) {
			if (!index.has(cap)) {
				index.set(cap, { id: p.id, name: p.name, description: p.description });
			}
		}
	}
	return index;
}

export function PluginShowcase() {
	const { t } = useTranslation();
	const resolveI18n = useI18nResolver();
	const [headerRef, headerInView] = useInView<HTMLDivElement>({
		threshold: 0.3,
	});
	const [capabilityToPlugin, setCapabilityToPlugin] = useState<
		Map<string, PluginMatch>
	>(() => new Map());

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch("/api/plugins");
				if (!res.ok) return;
				const body = (await res.json()) as { plugins?: RegistryPlugin[] };
				if (cancelled || !body.plugins) return;
				setCapabilityToPlugin(indexByCapability(body.plugins));
			} catch {
				// Landing page renders without a backend — silent fallback.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const cards = useMemo(
		() =>
			TILES.map((tile) => {
				const match = capabilityToPlugin.get(tile.capability);
				return {
					tile,
					pluginId: match?.id,
					displayName: match?.name ? resolveI18n(match.name) : undefined,
					description: match?.description
						? resolveI18n(match.description)
						: undefined,
				};
			}),
		[capabilityToPlugin, resolveI18n],
	);

	return (
		<section
			aria-labelledby="plugins-heading"
			className="relative w-full bg-card border-t border-border"
		>
			<div className="max-w-[1400px] mx-auto px-6 md:px-10 py-20 md:py-28">
				<div
					ref={headerRef}
					className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-12 items-end mb-12 md:mb-16 transition-all duration-700"
					style={{
						opacity: headerInView ? 1 : 0,
						transform: headerInView ? "translateY(0)" : "translateY(24px)",
					}}
				>
					<div className="md:col-span-7">
						<span className="ui-eyebrow text-muted-foreground">
							{t("home.plugins.eyebrow", "Plugins are first-class")}
						</span>
						<h2
							id="plugins-heading"
							className="font-display text-4xl md:text-6xl font-bold tracking-tight mt-4 leading-[1.05]"
						>
							{t(
								"home.plugins.title",
								"Eight runtimes. One pipeline. Zero hardcoded gameplay.",
							)}
						</h2>
					</div>
					<p className="md:col-span-5 text-base md:text-lg text-muted-foreground font-light leading-relaxed">
						{t(
							"home.plugins.subtitle",
							"Every plugin declares a priority band, a trigger mode, and a tool whitelist. The kernel discovers them by capability — never by ID.",
						)}
					</p>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-6 md:auto-rows-[200px] gap-px bg-border border border-border rounded-[var(--radius-card)] overflow-hidden">
					{cards.map((card, i) => (
						<PluginCard
							key={card.tile.key}
							tile={card.tile}
							pluginId={card.pluginId}
							displayName={card.displayName}
							description={card.description}
							delay={i * 75}
							t={t}
						/>
					))}
				</div>

				<p className="mt-10 text-sm text-muted-foreground text-center font-light">
					{t(
						"home.plugins.footnote",
						"Three more bundled plugins: dice, debug, slot-router. Drop in your own — same contract.",
					)}
				</p>
			</div>
		</section>
	);
}

interface CardProps {
	tile: Tile;
	pluginId: string | undefined;
	displayName: string | undefined;
	description: string | undefined;
	delay: number;
	t: (key: string, fallback: string) => string;
}

function PluginCard({
	tile,
	pluginId,
	displayName,
	description,
	delay,
	t,
}: CardProps) {
	const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.25 });
	const headline = displayName ?? pluginId ?? tile.capability;
	const blurb =
		description ??
		t(
			"home.plugins.unfilledSlot",
			"Awaiting a plugin to claim this capability.",
		);
	return (
		<article
			ref={ref}
			className={`group bg-card p-6 md:p-7 flex flex-col justify-between transition-all duration-500 hover:bg-muted/30 ${tile.span}`}
			style={{
				opacity: inView ? 1 : 0,
				transform: inView ? "translateY(0)" : "translateY(16px)",
				transitionDelay: `${delay}ms`,
			}}
		>
			<header className="flex items-start justify-between mb-4">
				<span className="ui-eyebrow text-muted-foreground">
					{t(tile.bandKey, tile.bandFallback)}
				</span>
				<span className="font-mono text-[10px] text-muted-foreground/70 uppercase tracking-wider">
					{tile.capability}
				</span>
			</header>
			<div className="flex-1 flex flex-col justify-end">
				<h3 className="font-mono text-xs text-muted-foreground mb-2">
					{pluginId ?? tile.capability}
				</h3>
				<p className="font-display text-base md:text-lg leading-snug text-foreground/90 group-hover:text-foreground transition-colors">
					{headline !== (pluginId ?? tile.capability) ? (
						<span className="block font-sans text-foreground mb-1">
							{headline}
						</span>
					) : null}
					{blurb}
				</p>
			</div>
		</article>
	);
}
