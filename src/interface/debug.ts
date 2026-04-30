/**
 * Tiny debug-logging gate for the client-side interfaces.
 *
 * Toggle at runtime in the browser DevTools console:
 *
 *     localStorage.setItem('i18n-email:debug', '1')   // enable
 *     localStorage.removeItem('i18n-email:debug')     // disable
 *
 * Then reload the page. We resolve the flag once at module load so
 * the per-call cost is just a boolean check; admins flipping the
 * flag mid-session reload anyway.
 *
 * `console.warn` and `console.error` paths are NOT routed through
 * here — those should always surface.
 */

const ENABLED: boolean = (() => {
	try {
		if (typeof localStorage === 'undefined') return false;
		const v = localStorage.getItem('i18n-email:debug');
		return v === '1' || v === 'true';
	} catch {
		return false;
	}
})();

export function dlog(...args: unknown[]): void {
	if (!ENABLED) return;
	console.log(...args);
}

export function dgroup(label: string): void {
	if (!ENABLED) return;
	console.groupCollapsed(label);
}

export function dgroupEnd(): void {
	if (!ENABLED) return;
	console.groupEnd();
}

export const isDebugEnabled = (): boolean => ENABLED;
