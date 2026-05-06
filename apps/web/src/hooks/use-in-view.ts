import { useEffect, useRef, useState } from "react";

interface Options {
	threshold?: number | number[];
	rootMargin?: string;
	once?: boolean;
}

export function useInView<T extends Element = HTMLElement>(
	options: Options = {},
): readonly [React.RefObject<T | null>, boolean] {
	const { threshold = 0.2, rootMargin = "0px", once = true } = options;
	const ref = useRef<T | null>(null);
	const [inView, setInView] = useState(false);

	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		if (typeof IntersectionObserver === "undefined") {
			setInView(true);
			return;
		}
		const observer = new IntersectionObserver(
			([entry]) => {
				const isIntersecting = entry?.isIntersecting ?? false;
				if (isIntersecting) {
					setInView(true);
					if (once) observer.disconnect();
				} else if (!once) {
					setInView(false);
				}
			},
			{ threshold, rootMargin },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [threshold, rootMargin, once]);

	return [ref, inView] as const;
}
