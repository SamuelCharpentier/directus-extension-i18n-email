import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import {
	DEFAULT_FALLBACK_LANG,
	TEMPLATES_COLLECTION,
	TRANSLATIONS_COLLECTION,
	VARIABLES_COLLECTION,
} from './constants';
import type {
	EmailTemplateRow,
	EmailTemplateTranslationRow,
	EmailTemplateVariableRow,
	RecipientUser,
} from './types';

function normaliseLang(lang: unknown): string | null {
	return typeof lang === 'string' && lang.length > 0 ? lang : null;
}

/**
 * Endonym for a BCP-47 tag — i.e. the language's name written in its
 * own language, in the consistent "Language (Region)" form.
 *   `localizeLangCode('fr-CA') → "Français (Canada)"`
 *   `localizeLangCode('en-US') → "English (United States)"`
 *
 * Uses `languageDisplay: 'standard'` so every region renders
 * parenthesized (avoids the inconsistent dialect form, which mixes
 * "American English" / "français canadien" / "français (France)").
 * The leading character is upper-cased so endonyms whose native form
 * is lowercase (e.g. `français`) still read as proper nouns in the
 * Directus language picker.
 *
 * Falls back to the raw code when `Intl.DisplayNames` rejects the
 * argument (e.g. malformed locale). The default fallback mode ('code')
 * guarantees a string return from `dn.of`, so no nullish coalesce is
 * needed there.
 */
export function localizeLangCode(code: string): string {
	try {
		const dn = new Intl.DisplayNames([code], {
			type: 'language',
			languageDisplay: 'standard',
		});
		const raw = dn.of(code) as string;
		return capitalizeFirst(raw, code);
	} catch {
		return code;
	}
}

/**
 * Upper-case the first character of `value` using the language's own
 * locale rules so non-ASCII letters (e.g. `i` in Turkish) capitalize
 * correctly. No-op when the first character is already upper-case or
 * has no case (digit, punctuation).
 */
export function capitalizeFirst(value: string, locale?: string): string {
	if (!value) return value;
	const first = value.charAt(0);
	const upper = locale ? first.toLocaleUpperCase(locale) : first.toUpperCase();
	if (first === upper) return value;
	return upper + value.slice(1);
}

export async function fetchDefaultLang(
	services: ExtensionsServices,
	schema: SchemaOverview,
	env: Record<string, unknown>,
): Promise<string> {
	const settings = new services.SettingsService({ schema, accountability: null });
	const result = await settings.readSingleton({ fields: ['default_language'] });
	const settingsLang = normaliseLang(result['default_language']);
	if (settingsLang) return settingsLang;
	const envLang = normaliseLang(env['I18N_EMAIL_FALLBACK_LANG']);
	return envLang ?? DEFAULT_FALLBACK_LANG;
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
	return normaliseLang(results[0]?.['language']);
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
 * Fetch one active template row by template_key.
 */
export async function fetchTemplateRow(
	templateKey: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateRow | null> {
	const items = new services.ItemsService(TEMPLATES_COLLECTION, { schema, accountability: null });
	const results = await items.readByQuery({
		filter: {
			template_key: { _eq: templateKey },
			is_active: { _eq: true },
		},
		limit: 1,
	});
	return (results[0] as EmailTemplateRow | undefined) ?? null;
}

export async function fetchAllTemplateRows(
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateRow[]> {
	const items = new services.ItemsService(TEMPLATES_COLLECTION, { schema, accountability: null });
	const results = await items.readByQuery({ limit: -1 });
	return results as EmailTemplateRow[];
}

/**
 * Fetch one translation row for a given template id + language.
 */
export async function fetchTranslationRow(
	templateId: string,
	languagesCode: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<EmailTemplateTranslationRow | null> {
	const items = new services.ItemsService(TRANSLATIONS_COLLECTION, {
		schema,
		accountability: null,
	});
	const results = await items.readByQuery({
		filter: {
			email_templates_id: { _eq: templateId },
			languages_code: { _eq: languagesCode },
		},
		limit: 1,
	});
	return (results[0] as EmailTemplateTranslationRow | undefined) ?? null;
}

/**
 * Resolve a template row + its best-fit translation for the effective
 * language, falling back to the default language if needed. A
 * translation row is treated as "no usable translation" (and the
 * fallback chain continues) when its `subject` is empty AND its
 * `i18n_variables` map is null/undefined/empty — this is the empty
 * placeholder shape the bootstrap seeds for the project's default
 * language. Returns null when the template itself is missing; returns
 * `{ row, translation: null }` when the template exists but has no
 * usable translation in either language.
 */
function isUsableTranslation(t: EmailTemplateTranslationRow | null): boolean {
	if (!t) return false;
	const hasSubject = typeof t.subject === 'string' && t.subject.length > 0;
	const i18nVars = t.i18n_variables;
	const hasStrings =
		i18nVars !== null &&
		i18nVars !== undefined &&
		typeof i18nVars === 'object' &&
		Object.keys(i18nVars).length > 0;
	return hasSubject || hasStrings;
}

export async function fetchTemplateWithTranslation(
	templateKey: string,
	effectiveLang: string,
	defaultLang: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<{ row: EmailTemplateRow; translation: EmailTemplateTranslationRow | null } | null> {
	const row = await fetchTemplateRow(templateKey, services, schema);
	if (!row || !row.id) return null;
	let translation = await fetchTranslationRow(row.id, effectiveLang, services, schema);
	if (!isUsableTranslation(translation) && effectiveLang !== defaultLang) {
		translation = await fetchTranslationRow(row.id, defaultLang, services, schema);
	}
	return { row, translation };
}

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
			role: { admin_access: { _eq: true } },
		},
		fields: ['email'],
		limit: -1,
	});
	// Post-filter: drop rows whose email is null/empty/non-string. Cheaper
	// than coupling the mock filter engine to `_nnull`.
	return results
		.map((u: Record<string, unknown>) => u['email'])
		.filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/**
 * Look up the recipient user (by email) for auto-hydration into the
 * Liquid template as `user`. Returns null when the recipient is not a
 * known Directus user — non-fatal.
 */
export async function fetchRecipientUser(
	recipientEmail: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
): Promise<RecipientUser | null> {
	const users = new services.ItemsService('directus_users', { schema, accountability: null });
	const results = await users.readByQuery({
		filter: { email: { _eq: recipientEmail } },
		fields: ['id', 'first_name', 'last_name', 'email', 'language'],
		limit: 1,
	});
	const row = results[0];
	if (!row) return null;
	return {
		id: String(row['id']),
		first_name: (row['first_name'] as string | null) ?? null,
		last_name: (row['last_name'] as string | null) ?? null,
		email: String(row['email']),
		language: (row['language'] as string | null) ?? null,
	};
}
