/**
 * Cross-component event bus for i18n-variable reconciliation in the
 * `email_templates` form. Lives in module scope so every mounted
 * `JsonInterface` (one per language tab) shares the same observer
 * surface.
 *
 * Why a window event (rather than a plain in-module observer list):
 *   - Lazy-mounted language tabs subscribe at mount time. The
 *     dispatcher (`TranslationsInterface`) doesn't know which tabs
 *     exist; using a window event means anyone can join without
 *     coordination.
 *   - The bus *also* listens to its own event so the latest
 *     broadcast is always available via `getLastBroadcast()` for
 *     mount-time catch-up — even broadcasts that originated from
 *     code paths that don't go through `dispatchReconcile()`
 *     (devtools, future hooks, third-party extensions).
 */

const EVENT_NAME = 'i18n-email:reconcile-keys';

export type Broadcast = {
	keys: ReadonlySet<string>;
	at: Date;
};

let lastBroadcast: Broadcast | null = null;

/** Return the most recent broadcast, or `null` if none has fired yet. */
export function getLastBroadcast(): Broadcast | null {
	return lastBroadcast;
}

/**
 * Fire a reconcile broadcast. The bus's own self-listener (registered
 * at module load) catches it and updates `lastBroadcast` — so callers
 * never need to update internal state directly.
 */
export function dispatchReconcile(keys: Iterable<string>): void {
	if (typeof window === 'undefined') return;
	const arr = Array.from(keys);
	window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { keys: arr, at: new Date() } }));
}

/**
 * Subscribe to live reconcile broadcasts. Returns an unsubscribe fn
 * for clean Vue `onBeforeUnmount` integration.
 */
export function subscribe(handler: (b: Broadcast) => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const listener = (ev: Event): void => {
		const b = readDetail(ev);
		if (b) handler(b);
	};
	window.addEventListener(EVENT_NAME, listener);
	return () => window.removeEventListener(EVENT_NAME, listener);
}

function readDetail(ev: Event): Broadcast | null {
	const detail = (ev as CustomEvent<{ keys?: unknown; at?: unknown }>).detail;
	if (!detail) return null;
	const keysArr = Array.isArray(detail.keys)
		? detail.keys.filter((k) => typeof k === 'string')
		: [];
	const at = detail.at instanceof Date ? detail.at : new Date();
	return { keys: new Set<string>(keysArr as string[]), at };
}

// Self-listener: keeps `lastBroadcast` in sync with whatever fires the
// event, regardless of whether `dispatchReconcile()` was the source.
if (typeof window !== 'undefined') {
	window.addEventListener(EVENT_NAME, (ev) => {
		const b = readDetail(ev);
		if (b) lastBroadcast = b;
	});
}
