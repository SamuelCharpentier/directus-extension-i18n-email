import type { EmailOptions, ExtensionsServices, SchemaOverview } from '@directus/types';
import type { Logger } from './types';
import {
	canonicalizeLang,
	fetchDefaultLang,
	fetchProjectName,
	fetchRecipientUser,
	fetchTemplateWithTranslation,
	fetchUserLang,
} from './directus';
import { applyTranslationsToEmail, extractRecipientEmail } from './email';
import { validateRequiredVariables } from './registry';
import { notifyAdmins } from './admin-alert';
import { BASE_LAYOUT_KEY, isSystemTemplateKey } from './constants';
import { renderLiquidString, renderLiquidStrings } from './liquid';
import { coerceI18nVariables } from './reconcile';
import type { EmailTemplateTranslationRow } from './types';

export type SendFilterDeps = {
	services: ExtensionsServices;
	getSchema: () => Promise<SchemaOverview>;
	logger: Pick<Logger, 'info' | 'warn' | 'error'>;
	env: Record<string, unknown>;
};

/**
 * Per-send control keys on `template.data`. They are input, never output:
 * read at the top of the filter, stripped before validation + Liquid
 * render, so they can't satisfy a required-variable check or leak into
 * templates.
 */
export const I18N_SKIP_PROCESSING = '_i18nSkipProcessing';
export const I18N_LANGUAGE_OVERRIDE = '_i18nLanguageOverride';

/**
 * The `email.send` filter body.
 *
 * 1. Read + strip `_i18n*` control keys (`_i18nSkipProcessing` returns
 *    the input untouched).
 * 2. Resolve recipient language (override → user → default).
 * 3. Fetch template + translation for that language (with fallback).
 * 4. Validate required variables.
 * 5. For protected system emails, hydrate `user` from directus_users.
 * 6. Inject i18n + base strings + subject + sender (name/address per
 *    translation fallback, only when the caller passed no from) into
 *    the email.
 *
 * Unknown template names pass through unchanged.
 */
export async function runSendFilter(
	input: EmailOptions,
	deps: SendFilterDeps,
): Promise<EmailOptions> {
	const { services, getSchema, logger, env } = deps;
	const templateName = input.template?.name;
	if (!templateName) return input;

	// Control keys live directly on template.data (never inside i18n.*,
	// which is filter output). They are read here, then stripped before
	// validation + Liquid render so they never leak into templates.
	const data = (input.template?.data ?? {}) as Record<string, unknown>;
	const skipProcessing = data[I18N_SKIP_PROCESSING] === true;
	if (skipProcessing) return input;

	delete data[I18N_SKIP_PROCESSING];
	const langOverride =
		typeof data[I18N_LANGUAGE_OVERRIDE] === 'string'
			? canonicalizeLang(data[I18N_LANGUAGE_OVERRIDE])
			: null;
	delete data[I18N_LANGUAGE_OVERRIDE];

	try {
		const schema = await getSchema();
		const recipientEmail = extractRecipientEmail(input.to);
		const [defaultLang, userLang, projectName] = await Promise.all([
			fetchDefaultLang(services, schema, env),
			recipientEmail ? fetchUserLang(recipientEmail, services, schema) : null,
			fetchProjectName(services, schema, env),
		]);
		const effectiveLang = langOverride ?? userLang ?? defaultLang;

		const resolved = await fetchTemplateWithTranslation(
			templateName,
			effectiveLang,
			defaultLang,
			services,
			schema,
		);
		if (!resolved) {
			logger.info(`[i18n-email] No DB template for "${templateName}" — passing through.`);
			return input;
		}
		const { row, translation } = resolved;

		// Required-variable validation.
		const validation = await validateRequiredVariables(templateName, data, services, schema);
		if (!validation.ok) {
			const reason = `Missing required variable(s) for template "${templateName}"`;
			logger.error(
				`[i18n-email] ${reason}: ${validation.missing.join(', ')} — aborting send.`,
			);
			void notifyAdmins(
				reason,
				{
					template: templateName,
					language: translation?.languages_code ?? effectiveLang,
					...(langOverride ? { languageOverride: langOverride } : {}),
					missing: validation.missing,
					recipient: recipientEmail,
				},
				services,
				schema,
				logger,
			);
			throw new Error(`${reason}: ${validation.missing.join(', ')}`);
		}

		// Base translation for i18n.base.*
		const baseLang = translation?.languages_code ?? effectiveLang;
		const baseResolved = await fetchTemplateWithTranslation(
			BASE_LAYOUT_KEY,
			baseLang,
			defaultLang,
			services,
			schema,
		);
		const baseStrings = baseResolved?.translation
			? coerceI18nVariables(baseResolved.translation.i18n_variables).in_template
			: null;

		// User hydration for protected system emails.
		let recipientUser = null;
		if (isSystemTemplateKey(row.template_key) && recipientEmail) {
			const existingUser = (input.template?.data as Record<string, unknown> | undefined)?.[
				'user'
			];
			if (!existingUser) {
				recipientUser = await fetchRecipientUser(recipientEmail, services, schema);
			}
		}

		const envFromName =
			typeof env['I18N_EMAIL_FALLBACK_FROM_NAME'] === 'string'
				? (env['I18N_EMAIL_FALLBACK_FROM_NAME'] as string)
				: null;
		const fallbackFromName = envFromName ?? projectName;
		const fromEnv = typeof env['EMAIL_FROM'] === 'string' ? (env['EMAIL_FROM'] as string) : '';

		// Pre-render Liquid in translated strings, subject, from_name,
		// and from_address
		// using the same context the body template will eventually see
		// (minus `i18n` itself — translations can't reference themselves).
		// This lets translators put `{{ user.first_name }}` directly inside
		// a translation value where word order varies by language.
		const renderCtx: Record<string, unknown> = {
			...data,
			...(recipientUser ? { user: recipientUser } : {}),
		};

		const renderedStrings = translation
			? await renderLiquidStrings(
					coerceI18nVariables(translation.i18n_variables).in_template,
					renderCtx,
					logger,
					`${templateName}.i18n_variables`,
				)
			: {};
		const renderedBaseStrings = baseStrings
			? await renderLiquidStrings(baseStrings, renderCtx, logger, 'base.strings')
			: null;
		const renderedSubject = translation?.subject
			? await renderLiquidString(
					translation.subject,
					renderCtx,
					logger,
					`${templateName}.subject`,
				)
			: (translation?.subject ?? '');
		const renderedFromName = translation?.from_name
			? await renderLiquidString(
					translation.from_name,
					renderCtx,
					logger,
					`${templateName}.from_name`,
				)
			: (translation?.from_name ?? null);
		const renderedFromAddress = translation?.from_address
			? await renderLiquidString(
					translation.from_address,
					renderCtx,
					logger,
					`${templateName}.from_address`,
				)
			: (translation?.from_address ?? null);

		const renderedTranslation: EmailTemplateTranslationRow | null = translation
			? {
					...translation,
					subject: renderedSubject,
					from_name: renderedFromName,
					from_address: renderedFromAddress,
					i18n_variables: renderedStrings,
				}
			: null;

		applyTranslationsToEmail(input, {
			translation: renderedTranslation,
			baseStrings: renderedBaseStrings,
			fallbackFromName,
			fromEnv,
			recipientUser,
			logger,
		});
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('Missing required variable')) {
			throw err;
		}
		logger.error(`[i18n-email] Failed to apply translations: ${(err as Error).message}`);
	}

	return input;
}
