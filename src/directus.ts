import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import { TEMPLATES_COLLECTION, VARIABLES_COLLECTION } from './constants';
import type { EmailTemplateRow, EmailTemplateVariableRow } from './types';

const HARDCODED_FALLBACK_LANG = 'en';

export async function fetchDefaultLang(
	services: ExtensionsServices,
	schema: SchemaOverview,
	env: Record<string, unknown>,
): Promise<string> {
	const settings = new services.SettingsService({ schema, accountability: null });
	const result = await settings.readSingleton({ fields: ['default_language'] });
	const lang = result['default_language'];
	const [primary] = typeof lang === 'string' ? lang.split('-') : [];
	const envFallback =
		typeof env['I18N_EMAIL_FALLBACK_LANG'] === 'string'
			? env['I18N_EMAIL_FALLBACK_LANG']
			: HARDCODED_FALLBACK_LANG;
	return primary ?? envFallback;
}

export async function fetchUserLang(
	recipientEmail: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<string | null> {
	const users = new services.ItemsService('directus_users', { schema, accountability: null });
	const results = await users.readByQuery({
		filter: { email: { _eq: recipientEmail } },
		fields: ['language'],
		limit: 1,
	});
	const lang = results[0]?.['language'];
	const [primary] = typeof lang === 'string' ? lang.split('-') : [];
	return primary ?? null;
}

export async function fetchProjectName(
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<string | null> {
	const settings = new services.SettingsService({ schema, accountability: null });
	const result = await settings.readSingleton({ fields: ['project_name'] });
	const name = result['project_name'];
	return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * Fetch one template row by (template_key, language). Returns null if not found.
 */
export async function fetchTemplateRow(
	templateKey: string,
	language: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateRow | null> {
	const items = new services.ItemsService(TEMPLATES_COLLECTION, { schema, accountability: null });
	const results = await items.readByQuery({
		filter: {
			template_key: { _eq: templateKey },
			language: { _eq: language },
			is_active: { _eq: true },
		},
		limit: 1,
	});
	return (results[0] as EmailTemplateRow | undefined) ?? null;
}

/**
 * Fetch all active template rows. Used by the sync writer to rebuild
 * locales/{lang}.json files.
 */
export async function fetchAllTemplateRows(
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateRow[]> {
	const items = new services.ItemsService(TEMPLATES_COLLECTION, { schema, accountability: null });
	const results = await items.readByQuery({
		filter: { is_active: { _eq: true } },
		limit: -1,
	});
	return results as EmailTemplateRow[];
}

/**
 * Fetch all variable registry rows for a given template key.
 */
export async function fetchTemplateVariables(
	templateKey: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateVariableRow[]> {
	const items = new services.ItemsService(VARIABLES_COLLECTION, {
		schema,
		accountability: null,
	});
	const results = await items.readByQuery({
		filter: { template_key: { _eq: templateKey } },
		limit: -1,
	});
	return results as EmailTemplateVariableRow[];
}

/**
 * Resolve the email addresses of all active admin users. Used by the
 * admin-alert module to notify operators when a send fails.
 */
export async function fetchAdminEmails(
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<string[]> {
	const users = new services.ItemsService('directus_users', {
		schema,
		accountability: null,
	});
	const results = await users.readByQuery({
		filter: {
			status: { _eq: 'active' },
			email: { _nnull: true },
			role: { admin_access: { _eq: true } },
		},
		fields: ['email'],
		limit: -1,
	});
	return results
		.map((u: Record<string, unknown>) => u['email'])
		.filter((e): e is string => typeof e === 'string' && e.length > 0);
}
