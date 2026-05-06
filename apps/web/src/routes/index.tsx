import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, useEffect } from "react";
import { Hero } from "@/components/landing/Hero";
import { PipelineScrolly } from "@/components/landing/PipelineScrolly";
import { PluginShowcase } from "@/components/landing/PluginShowcase";
import { DemoSection } from "@/components/landing/DemoSection";
import { CTA } from "@/components/landing/CTA";

export const Route = createFileRoute("/")({
	component: HomePage,
});

function HomePage() {
	// The app shell uses `<main className="overflow-hidden">`, so the home
	// page provides its own scroll container. The container is also the
	// IntersectionObserver root for the scrolly-telling sections.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);

	useEffect(() => {
		setScrollRoot(scrollRef.current);
	}, []);

	return (
		<div
			ref={scrollRef}
			className="h-full w-full overflow-y-auto overflow-x-hidden bg-background"
		>
			<Hero />
			<PipelineScrolly scrollRoot={scrollRoot} />
			<PluginShowcase />
			<DemoSection />
			<CTA />
		</div>
	);
}
