import { Liquid } from 'liquidjs';
import type { Logger, TranslationStrings } from './types';

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
