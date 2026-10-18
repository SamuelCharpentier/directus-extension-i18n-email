/**
 * `DEFAULT_LANGUAGE` / `DEFAULT_PROJECT_NAME` env support.
 *
 * Directus has no env var for the project default language or project
 * name on a fresh DB: its own install writes `en-US` and `Directus`
 * into `directus_settings`. These helpers let an operator pin them on
 * boot so seeds and sender fallbacks are right from the first run.
 *
 * Idempotent and convergent: they write only when the env value differs
 * from what's stored. That makes load order irrelevant if this logic is
 * later lifted into standalone `directus-extension-default-language` /
 * `directus-extension-default-project-name` packages — whichever caller
 * runs first applies the value, the other is a no-op.
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

/**
 * Pin `directus_settings.project_name` from `DEFAULT_PROJECT_NAME`.
 * Same idempotent/convergent contract as `ensureDefaultLanguage`:
 * env always wins while set; nothing is written when unset or when
 * the stored value already matches.
 */
export async function ensureDefaultProjectName(
	services: ExtensionsServices,
	schema: SchemaOverview,
	env: Record<string, unknown>,
	logger: Pick<Logger, 'info' | 'warn'>,
): Promise<string | null> {
	const desired =
		typeof env['DEFAULT_PROJECT_NAME'] === 'string' ? env['DEFAULT_PROJECT_NAME'].trim() : '';
	if (!desired) return null;

	try {
		const settings = new services.SettingsService({ schema, accountability: null });
		const current = await settings.readSingleton({ fields: ['project_name'] });
		const currentName = typeof current['project_name'] === 'string' ? current['project_name'] : null;
		if (currentName === desired) return desired;

		await settings.upsertSingleton({ project_name: desired }, { emitEvents: false });
		logger.info(
			`[i18n-email] Set project name ${currentName ?? '(unset)'} → ${desired} (DEFAULT_PROJECT_NAME).`,
		);
		return desired;
	} catch (err) {
		logger.warn(
			`[i18n-email] Could not apply DEFAULT_PROJECT_NAME=${desired}: ${(err as Error).message}`,
		);
		return null;
	}
}
