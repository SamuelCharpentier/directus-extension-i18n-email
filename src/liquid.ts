import { Liquid } from 'liquidjs';
import type { Logger, TranslationStrings } from './types';
import { BASE_LAYOUT_KEY } from './constants';

/**
 * Shared LiquidJS engine for the pre-render pass over translation
 * strings. We intentionally keep this isolated from the engine that
 * Directus's MailService uses to render the template body — the body
 * pass renders our already-resolved strings verbatim.
 *
 * Strict variable lookup is OFF on purpose: a missing variable in a
 * translation should degrade to an empty interpolation, not crash the
 * send.
 */
const engine = new Liquid({ cache: true });

const LIQUID_TOKEN_PATTERN = /\{\{|\{%/;

/**
 * Render a single Liquid string with the given context. On parse or
 * render failure, warn and fall back to the raw template so the email
 * still goes out.
 *
 * Strings without `{{` / `{%` are returned as-is to avoid the engine
 * round-trip for plain text (the common case).
 */
export async function renderLiquidString(
	template: string,
	context: Record<string, unknown>,
	logger: Pick<Logger, 'warn'>,
	label: string,
): Promise<string> {
	if (!template || !LIQUID_TOKEN_PATTERN.test(template)) return template;
	try {
		return await engine.parseAndRender(template, context);
	} catch (err) {
		logger.warn(
			`[i18n-email] Liquid render failed for ${label}: ${(err as Error).message} — using raw value.`,
		);
		return template;
	}
}

/**
 * Render every value of a translation strings map. Keys are preserved.
 * Per-key failures are isolated (a bad string doesn't poison the rest).
 */
export async function renderLiquidStrings(
	strings: TranslationStrings,
	context: Record<string, unknown>,
	logger: Pick<Logger, 'warn'>,
	label: string,
): Promise<TranslationStrings> {
	const out: TranslationStrings = {};
	for (const [key, value] of Object.entries(strings)) {
		out[key] = await renderLiquidString(value, context, logger, `${label}.${key}`);
	}
	return out;
}

/**
 * Static-analyse a template body and return the set of `i18n.*` keys
 * it references. Powers translation-row reconciliation: keys present
 * in the body but missing from the JSON are added empty; keys present
 * in the JSON but absent from the body are moved into `unused_i18n_variables`.
 *
 * Behaviour:
 *  - Uses LiquidJS's `globalVariableSegmentsSync` (introspection only,
 *    no rendering). `partials: false` skips child templates so a
 *    `{% layout "base" %}` directive doesn't trip the loader.
 *  - For the `base` template, only `i18n.base.*` paths are returned
 *    (with the `base.` prefix stripped). Other paths are ignored —
 *    they belong to the consuming template.
 *  - For non-`base` templates, `i18n.base.*` paths are skipped (they
 *    are rendered through the layout's own translation row).
 *  - Dynamic lookups like `{{ i18n[var] }}` (where the second segment
 *    is itself an array) are silently dropped — they cannot be resolved
 *    statically.
 *  - Numeric segments (e.g. `i18n.list[0]`) are coerced to strings; the
 *    extension treats `strings` as a flat key→string map so this is
 *    rare in practice.
 *  - Parser failures degrade to an empty set (and warn) so a malformed
 *    body never blocks save.
 */
export function extractI18nKeys(
	body: string,
	templateKey: string,
	logger: Pick<Logger, 'warn'>,
): Set<string> {
	const out = new Set<string>();
	if (!body) return out;
	let segments: Array<Array<string | number | unknown[]>>;
	try {
		const tpl = engine.parse(body);
		segments = engine.globalVariableSegmentsSync(tpl, { partials: false }) as Array<
			Array<string | number | unknown[]>
		>;
	} catch (err) {
		logger.warn(
			`[i18n-email] Static analysis failed for "${templateKey}": ${(err as Error).message} — skipping i18n key extraction.`,
		);
		return out;
	}
	const isBase = templateKey === BASE_LAYOUT_KEY;
	for (const segs of segments) {
		if (segs.length < 2) continue;
		if (segs[0] !== 'i18n') continue;
		// Drop the leading `i18n.` segment.
		const rest = segs.slice(1);
		// Reject paths whose first remaining segment is dynamic (array)
		// — there's nothing static to record.
		const head = rest[0];
		if (typeof head !== 'string' && typeof head !== 'number') continue;

		let keyParts: Array<string | number>;
		if (isBase) {
			if (head !== 'base') continue;
			keyParts = rest.slice(1) as Array<string | number>;
			if (keyParts.length === 0) continue;
		} else {
			if (head === 'base') continue;
			keyParts = rest as Array<string | number>;
		}
		// Skip the key entirely if any deeper segment is dynamic — we
		// cannot statically derive a stable storage key for it.
		if (keyParts.some((p) => typeof p !== 'string' && typeof p !== 'number')) continue;
		out.add(keyParts.map(String).join('.'));
	}
	return out;
}
