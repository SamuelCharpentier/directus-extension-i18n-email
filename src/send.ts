import type { EmailOptions } from '@directus/types';
import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type { Logger } from './types';
import { fetchDefaultLang, fetchProjectName, fetchUserLang, fetchTemplateRow } from './directus';
import { applyTranslationsToEmail, extractRecipientEmail } from './email';
import { validateRequiredVariables } from './registry';
import { notifyAdmins, isAdminErrorTemplate } from './admin-alert';
import type { EmailTemplateRow, TemplateTrans } from './types';
import { BASE_LAYOUT_KEY } from './constants';

/**
 * Turn a DB row into the flat TemplateTrans shape expected by
 * applyTranslationsToEmail (subject + from_name + spread strings).
 */
function rowToTrans(row: EmailTemplateRow): TemplateTrans {
	return {
		...row.strings,
		...(row.subject ? { subject: row.subject } : {}),
		...(row.from_name ? { from_name: row.from_name } : {}),
	};
}

export type SendFilterDeps = {
	services: ExtensionsServices;
	getSchema: () => Promise<SchemaOverview>;
	logger: Pick<Logger, 'info' | 'warn' | 'error'>;
	env: Record<string, unknown>;
};

/**
 * The `email.send` filter body. Pulls translations from the DB, applies
 * subject/from/i18n to the email, validates required variables, and
 * notifies admins on failures.
 *
 * Non-matching template names pass through untouched so callers that
 * rely on raw Directus template rendering are unaffected.
 */
export async function runSendFilter(
	input: EmailOptions,
	deps: SendFilterDeps,
): Promise<EmailOptions> {
	const { services, getSchema, logger, env } = deps;
	const templateName = input.template?.name;
	if (!templateName) return input;
	// Never re-process the admin-error send itself — prevents loops.
	if (isAdminErrorTemplate(templateName)) return input;

	try {
		const schema = await getSchema();
		const recipientEmail = extractRecipientEmail(input.to);
		const [defaultLang, userLang, projectName] = await Promise.all([
			fetchDefaultLang(services, schema, env),
			recipientEmail ? fetchUserLang(recipientEmail, services, schema) : null,
			fetchProjectName(services, schema),
		]);
		const effectiveLang = userLang ?? defaultLang;

		// Primary lookup: (key, effectiveLang). Fallback: (key, defaultLang).
		let row = await fetchTemplateRow(templateName, effectiveLang, services, schema);
		if (!row) {
			if (effectiveLang !== defaultLang) {
				row = await fetchTemplateRow(templateName, defaultLang, services, schema);
			}
		}
		if (!row) {
			logger.info(
				`[i18n-email] No DB template for "${templateName}" in ${effectiveLang}/${defaultLang} — passing through.`,
			);
			return input;
		}

		// Required-variable validation.
		const data = (input.template!.data ?? {}) as Record<string, unknown>;
		const validation = await validateRequiredVariables(templateName, data, services, schema);
		if (!validation.ok) {
			const reason = `Missing required variable(s) for template "${templateName}"`;
			logger.error(
				`[i18n-email] ${reason}: ${validation.missing.join(', ')} — aborting send.`,
			);
			// Fire-and-forget admin alert (don't await — don't block the throw).
			void notifyAdmins(
				reason,
				{
					template: templateName,
					language: row.language,
					missing: validation.missing,
					recipient: recipientEmail,
				},
				services,
				schema,
				logger,
			);
			throw new Error(`${reason}: ${validation.missing.join(', ')}`);
		}

		// Apply subject/from/i18n from DB row.
		const trans = rowToTrans(row);
		const envFromName =
			typeof env['I18N_EMAIL_FALLBACK_FROM_NAME'] === 'string'
				? (env['I18N_EMAIL_FALLBACK_FROM_NAME'] as string)
				: undefined;
		const effectiveTrans = trans.from_name
			? trans
			: { ...trans, from_name: envFromName ?? projectName ?? undefined };
		const fromEnv = typeof env['EMAIL_FROM'] === 'string' ? (env['EMAIL_FROM'] as string) : '';
		applyTranslationsToEmail(input, effectiveTrans, fromEnv);

		// Merge the base layout strings (if any) as i18n.base.*
		const baseRow = await fetchTemplateRow(BASE_LAYOUT_KEY, row.language, services, schema);
		if (baseRow) {
			// applyTranslationsToEmail guarantees input.template.data.i18n exists.
			const template = input.template!;
			const data = template.data as Record<string, unknown>;
			const existing = data['i18n'] as Record<string, unknown>;
			data['i18n'] = { ...existing, base: baseRow.strings };
		}
	} catch (err) {
		// Re-throw validation errors so the send actually aborts.
		if (err instanceof Error && err.message.startsWith('Missing required variable')) {
			throw err;
		}
		logger.error(`[i18n-email] Failed to apply translations: ${(err as Error).message}`);
	}

	return input;
}
