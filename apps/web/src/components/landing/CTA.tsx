import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { useInView } from "@/hooks/use-in-view";

const REPO_URL = "https://github.com/ackness/covel";
const DOCS_URL = "https://github.com/ackness/covel/tree/main/docs";

export function CTA() {
	const { t } = useTranslation();
	const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.3 });

	return (
		<section
			aria-labelledby="cta-heading"
			className="relative w-full bg-card border-t border-border overflow-hidden"
		>
			<div className="max-w-[1400px] mx-auto px-6 md:px-10 py-24 md:py-36">
				<div
					ref={ref}
					className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16 transition-all duration-700"
					style={{
						opacity: inView ? 1 : 0,
						transform: inView ? "translateY(0)" : "translateY(32px)",
					}}
				>
					<div className="md:col-span-7">
						<span className="ui-eyebrow text-muted-foreground">
							{t("home.cta.eyebrow", "Three doors")}
						</span>
						<h2
							id="cta-heading"
							className="font-display text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mt-6 leading-[0.95]"
						>
							{t("home.cta.line1", "Pick a world.")}
							<br />
							<span className="text-muted-foreground italic font-light">
								{t("home.cta.line2", "Or build one.")}
							</span>
						</h2>
					</div>

					<ul className="md:col-span-5 flex flex-col gap-px bg-border border border-border rounded-[var(--radius-card)] overflow-hidden">
						<Door
							to="/session"
							label={t("home.cta.playLabel", "Just play")}
							body={t(
								"home.cta.playBody",
								"Pick a bundled world and dive in. No setup beyond a model key.",
							)}
							cta={t("home.cta.playAction", "Open Studio")}
							kind="internal"
						/>
						<Door
							href={DOCS_URL}
							label={t("home.cta.authorLabel", "Author a plugin")}
							body={t(
								"home.cta.authorBody",
								"PLUGIN.md + a manifest. The kernel discovers the rest.",
							)}
							cta={t("home.cta.authorAction", "Read the guide")}
							kind="external"
						/>
						<Door
							href={REPO_URL}
							label={t("home.cta.contribLabel", "Read the source")}
							body={t(
								"home.cta.contribBody",
								"13 packages, 8 plugins, fully open. Audit, fork, contribute.",
							)}
							cta={t("home.cta.contribAction", "Browse repo")}
							kind="external"
						/>
					</ul>
				</div>
			</div>
		</section>
	);
}

interface DoorProps {
	label: string;
	body: string;
	cta: string;
	to?: string;
	href?: string;
	kind: "internal" | "external";
}

function Door({ label, body, cta, to, href, kind }: DoorProps) {
	const className =
		"group bg-card p-6 md:p-7 flex items-start justify-between gap-5 hover:bg-muted/40 transition-colors";
	const content = (
		<>
			<div>
				<p className="ui-eyebrow text-muted-foreground mb-2">{label}</p>
				<p className="font-display text-base md:text-lg leading-snug text-foreground/90 max-w-sm mb-3">
					{body}
				</p>
				<p className="text-sm font-medium text-primary inline-flex items-center gap-1.5 group-hover:gap-2.5 transition-all">
					{cta}
					<ArrowRight className="h-4 w-4" />
				</p>
			</div>
		</>
	);
	if (kind === "internal" && to) {
		return (
			<li>
				<Link to={to} className={className}>
					{content}
				</Link>
			</li>
		);
	}
	return (
		<li>
			<a
				href={href}
				target="_blank"
				rel="noreferrer noopener"
				className={className}
			>
				{content}
			</a>
		</li>
	);
}
