/**
 * `DEFAULT_LANGUAGE` env support.
 *
 * Directus has no env var for the project default language on a fresh
 * DB: its own install writes `en-US` into `directus_settings`. This
 * helper lets an operator pin the default language on boot so the seed
 * language is right from the first run.
 *
 * Idempotent and convergent: it writes only when the env value differs
 * from what's stored. That makes load order irrelevant if this logic is
 * later lifted into a standalone `directus-extension-default-language`
 * package — whichever caller runs first applies the value, the other is
 * a no-op.
 */
import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type { Logger } from './types';

export async function ensureDefaultLanguage(
	services: ExtensionsServices,
	schema: SchemaOverview,
	env: Record<string, unknown>,
	logger: Pick<Logger, 'info' | 'warn'>,
): Promise<string | null> {
	const raw = typeof env['DEFAULT_LANGUAGE'] === 'string' ? env['DEFAULT_LANGUAGE'].trim() : '';
	if (!raw) return null;

	let desired: string;
	try {
		desired = Intl.getCanonicalLocales(raw)[0] ?? raw;
	} catch {
		logger.warn(
			`[i18n-email] DEFAULT_LANGUAGE "${raw}" is not a valid BCP-47 tag — ignoring.`,
		);
		return null;
	}

	try {
		const settings = new services.SettingsService({ schema, accountability: null });
		const current = await settings.readSingleton({ fields: ['default_language'] });
		const currentLang = typeof current['default_language'] === 'string' ? current['default_language'] : null;
		if (currentLang === desired) return desired;

		await settings.upsertSingleton({ default_language: desired }, { emitEvents: false });
		logger.info(
			`[i18n-email] Set default language ${currentLang ?? '(unset)'} → ${desired} (DEFAULT_LANGUAGE).`,
		);
		return desired;
	} catch (err) {
		logger.warn(
			`[i18n-email] Could not apply DEFAULT_LANGUAGE=${desired}: ${(err as Error).message}`,
		);
		return null;
	}
}
