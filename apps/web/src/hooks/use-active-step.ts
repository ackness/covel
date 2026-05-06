import { useEffect, useRef, useState } from "react";

/**
 * Tracks which child "step" element is currently in the configured reading
 * band. Used by scrolly-telling sections where a sticky visual reacts to
 * text steps. Falls back to viewport when no scroll root is supplied.
 *
 * The middle 20% of the viewport (or scroll root) acts as the activation
 * band — when a step's vertical centre crosses that band it wins.
 */
export function useActiveStep(
	count: number,
	scrollRoot?: HTMLElement | null,
): readonly [(index: number) => (node: HTMLElement | null) => void, number] {
	const stepRefs = useRef<Array<HTMLElement | null>>([]);
	const [active, setActive] = useState(0);

	const setRef = (index: number) => (node: HTMLElement | null) => {
		stepRefs.current[index] = node;
	};

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (typeof IntersectionObserver === "undefined") return;
		const root = scrollRoot ?? null;
		const observer = new IntersectionObserver(
			(entries) => {
				// Multiple steps may be in the band; pick the one whose centre is
				// closest to the activation line.
				const rootRect = root
					? root.getBoundingClientRect()
					: { top: 0, height: window.innerHeight };
				const line = rootRect.top + rootRect.height * 0.5;
				let bestIndex = active;
				let bestDistance = Number.POSITIVE_INFINITY;
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const idx = stepRefs.current.indexOf(entry.target as HTMLElement);
					if (idx < 0) continue;
					const rect = entry.boundingClientRect;
					const distance = Math.abs(rect.top + rect.height / 2 - line);
					if (distance < bestDistance) {
						bestDistance = distance;
						bestIndex = idx;
					}
				}
				if (Number.isFinite(bestDistance)) setActive(bestIndex);
			},
			{
				root,
				// Only the middle 30% of the root counts as "active".
				rootMargin: "-35% 0px -35% 0px",
				threshold: [0, 0.5, 1],
			},
		);
		for (const node of stepRefs.current) {
			if (node) observer.observe(node);
		}
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [count, scrollRoot]);

	return [setRef, active] as const;
}
