/**
 * Global reload overlay — shown while the desktop shell restarts the
 * backend sidecar.
 *
 * Driven by two window events so any module (without prop-drilling a
 * context) can request the overlay:
 *   - `covel:reload-overlay:show` (detail: { message? })
 *   - `covel:reload-overlay:hide`
 *
 * The helper `reloadServerAndWait()` in `lib/desktop-bridge.ts` owns the
 * lifecycle; components normally call that helper rather than dispatching
 * events directly.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

interface OverlayState {
	visible: boolean;
	message?: string;
}

const SHOW_EVENT = "covel:reload-overlay:show";
const HIDE_EVENT = "covel:reload-overlay:hide";

export function showReloadOverlay(message?: string): void {
	window.dispatchEvent(new CustomEvent(SHOW_EVENT, { detail: { message } }));
}

export function hideReloadOverlay(): void {
	window.dispatchEvent(new Event(HIDE_EVENT));
}

export function ReloadOverlay() {
	const { t } = useTranslation();
	const [state, setState] = useState<OverlayState>({ visible: false });

	useEffect(() => {
		const onShow = (event: Event) => {
			const detail = (event as CustomEvent<{ message?: string }>).detail;
			setState({ visible: true, message: detail?.message });
		};
		const onHide = () => setState({ visible: false });
		window.addEventListener(SHOW_EVENT, onShow);
		window.addEventListener(HIDE_EVENT, onHide);
		return () => {
			window.removeEventListener(SHOW_EVENT, onShow);
			window.removeEventListener(HIDE_EVENT, onHide);
		};
	}, []);

	if (!state.visible) return null;

	return (
		<div
			className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm"
			role="alert"
			aria-live="assertive"
		>
			<Loader2 className="w-6 h-6 text-primary animate-spin" />
			<div className="text-sm font-medium">
				{state.message ?? t("reload.reloading", "Reloading server…")}
			</div>
			<div className="text-xs text-muted-foreground">
				{t("reload.reloadingHint", "This takes a few seconds.")}
			</div>
		</div>
	);
}
