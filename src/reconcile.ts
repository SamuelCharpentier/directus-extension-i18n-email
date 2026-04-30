import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type { EmailTemplateTranslationRow, Logger, TranslationStrings } from './types';
import { TEMPLATES_COLLECTION, TRANSLATIONS_COLLECTION } from './constants';
import { extractI18nKeys } from './liquid';

export type ReconcileResult = {
	i18n_variables: TranslationStrings;
	unused_i18n_variables: TranslationStrings;
	changed: boolean;
};

/**
 * Pure reconciliation between a translation row's stored maps and the
 * set of `i18n.*` keys actually referenced by the current template
 * body.
 *
 * Rules:
 *   - Keys in `usedKeys` missing from `i18n_variables`: added with value `""`.
 *     If the same key already lives in `unused_i18n_variables`, its previous
 *     value is restored (so toggling a variable in/out of the body is
 *     non-destructive).
 *   - Keys in `i18n_variables` absent from `usedKeys`: moved into
 *     `unused_i18n_variables` with their value preserved.
 *   - Keys in `unused_i18n_variables` that are also in `usedKeys`: removed
 *     from `unused_i18n_variables` (they're now active and live in `i18n_variables`).
 *   - Operation is idempotent: running it twice yields the same result
 *     and reports `changed: false` on the second pass.
 */
export function reconcileTranslationStrings(
	currentActive: TranslationStrings | null | undefined,
	currentUnused: TranslationStrings | null | undefined,
	usedKeys: ReadonlySet<string>,
): ReconcileResult {
	const active: TranslationStrings = { ...(currentActive ?? {}) };
	const unused: TranslationStrings = { ...(currentUnused ?? {}) };

	// Promote unused → active when the body references them again.
	for (const key of usedKeys) {
		if (!(key in active)) {
			if (key in unused) {
				active[key] = unused[key]!;
				delete unused[key];
			} else {
				active[key] = '';
			}
		}
	}

	// Demote active → unused when the body no longer references them.
	for (const key of Object.keys(active)) {
		if (!usedKeys.has(key)) {
			unused[key] = active[key]!;
			delete active[key];
		}
	}

	const changed =
		!shallowStringEqual(currentActive ?? {}, active) ||
		!shallowStringEqual(currentUnused ?? {}, unused);
	return { i18n_variables: active, unused_i18n_variables: unused, changed };
}

function shallowStringEqual(a: TranslationStrings, b: TranslationStrings): boolean {
	const ak = Object.keys(a);
	if (ak.length !== Object.keys(b).length) return false;
	for (const k of ak) {
		if (a[k] !== b[k]) return false;
	}
	return true;
}

/**
 * Build a starter `i18n_variables` map for a brand-new translation row. Every
 * key referenced by the template body gets an empty string. Used by
 * the `email_template_translations.items.create` filter so admins
 * land on a populated form instead of an empty `{}`.
 */
export function buildInitialStrings(
	templateBody: string,
	templateKey: string,
	logger: Pick<Logger, 'warn'>,
): TranslationStrings {
	const used = extractI18nKeys(templateBody, templateKey, logger);
	const out: TranslationStrings = {};
	for (const key of used) out[key] = '';
	return out;
}

/**
 * Walk every translation row attached to a template and reconcile its
 * `i18n_variables` / `unused_i18n_variables` against the body. Only writes
 * rows that actually changed.
 */
export async function reconcileTranslationsForTemplate(
	template: { id?: string; template_key: string; body: string },
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'info' | 'warn'>,
): Promise<{ scanned: number; updated: number }> {
	if (!template.id) {
		logger.warn(
			`[i18n-email] Skipping reconcile for ${template.template_key}: missing template id.`,
		);
		return { scanned: 0, updated: 0 };
	}
	const usedKeys = extractI18nKeys(template.body ?? '', template.template_key, logger);
	const items = new services.ItemsService(TRANSLATIONS_COLLECTION, {
		schema,
		accountability: null,
	});
	let rows: EmailTemplateTranslationRow[];
	try {
		rows = (await items.readByQuery({
			filter: { email_templates_id: { _eq: template.id } },
			limit: -1,
		})) as EmailTemplateTranslationRow[];
	} catch (err) {
		logger.warn(
			`[i18n-email] Failed to read translation rows for ${template.template_key}: ${(err as Error).message}`,
		);
		return { scanned: 0, updated: 0 };
	}

	let updated = 0;
	for (const row of rows) {
		const result = reconcileTranslationStrings(
			row.i18n_variables,
			row.unused_i18n_variables,
			usedKeys,
		);
		if (!result.changed) continue;
		try {
			await items.updateOne(row.id!, {
				i18n_variables: result.i18n_variables,
				unused_i18n_variables: result.unused_i18n_variables,
			});
			updated += 1;
		} catch (err) {
			logger.warn(
				`[i18n-email] Failed to reconcile translation ${row.id} for ${template.template_key}: ${(err as Error).message}`,
			);
		}
	}
	if (updated > 0) {
		logger.info(
			`[i18n-email] Reconciled ${updated}/${rows.length} translation row(s) for ${template.template_key}.`,
		);
	}
	return { scanned: rows.length, updated };
}

/**
 * Look up a single template row by id. Used by the translations
 * `items.create` filter to derive `usedKeys` for the parent body.
 * Returns null on miss or read error.
 */
export async function fetchTemplateBodyById(
	id: string,
	services: ExtensionsServices,
	schema: SchemaOverview,
	logger: Pick<Logger, 'warn'>,
): Promise<{ template_key: string; body: string } | null> {
	try {
		const items = new services.ItemsService(TEMPLATES_COLLECTION, {
			schema,
			accountability: null,
		});
		const rows = (await items.readMany([id], {
			fields: ['template_key', 'body'],
		})) as Array<{ template_key: string; body: string }>;
		const row = rows[0];
		if (!row) return null;
		return { template_key: row.template_key, body: row.body ?? '' };
	} catch (err) {
		logger.warn(
			`[i18n-email] Failed to load template ${id} for translation pre-fill: ${(err as Error).message}`,
		);
		return null;
	}
}
