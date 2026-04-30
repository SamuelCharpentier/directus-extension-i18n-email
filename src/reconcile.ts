import type { ExtensionsServices, SchemaOverview } from '@directus/types';
import type {
	EmailTemplateTranslationRow,
	I18nVariables,
	Logger,
	TranslationStrings,
} from './types';
import { TEMPLATES_COLLECTION, TRANSLATIONS_COLLECTION } from './constants';
import { extractI18nKeys } from './liquid';

export type ReconcileResult = {
	value: I18nVariables;
	changed: boolean;
};

/**
 * Pure reconciliation between a translation row's stored variables map
 * and the set of `i18n.*` keys actually referenced by the current
 * template body.
 *
 * Rules:
 *   - Keys in `usedKeys` missing from `in_template`: added with value `""`.
 *     If the same key already lives in `unused`, its previous value is
 *     restored (toggling a variable in/out of the body is non-destructive).
 *   - Keys in `in_template` absent from `usedKeys`: moved into `unused`
 *     with their value preserved.
 *   - Keys in `unused` that are also in `usedKeys`: promoted into
 *     `in_template`.
 *   - Operation is idempotent: running it twice yields the same result
 *     and reports `changed: false` on the second pass.
 */
export function reconcileTranslationStrings(
	currentValue: I18nVariables | TranslationStrings | string | null | undefined,
	usedKeys: ReadonlySet<string>,
): ReconcileResult {
	const baseline = coerceI18nVariables(currentValue);

	const workIn: TranslationStrings = { ...baseline.in_template };
	const workUnused: TranslationStrings = { ...baseline.unused };

	// Promote unused → in_template when the body references them again.
	for (const key of usedKeys) {
		if (!(key in workIn)) {
			if (key in workUnused) {
				workIn[key] = workUnused[key]!;
				delete workUnused[key];
			} else {
				workIn[key] = '';
			}
		}
	}

	// Demote in_template → unused when the body no longer references them.
	for (const key of Object.keys(workIn)) {
		if (!usedKeys.has(key)) {
			workUnused[key] = workIn[key]!;
			delete workIn[key];
		}
	}

	const changed =
		!shallowStringEqual(baseline.in_template, workIn) ||
		!shallowStringEqual(baseline.unused, workUnused);
	return {
		value: { in_template: workIn, unused: workUnused },
		changed,
	};
}

/**
 * Coerce any plausibly-stored value into the canonical `I18nVariables`
 * shape. Handles:
 *   - `null` / `undefined` → empty.
 *   - JSON-encoded string of either shape (some DB drivers return this).
 *   - New shape `{ in_template, unused }` (passed through).
 *   - Legacy bare-key shape `{ key: 'value', ... }` (treated as `in_template`).
 *   - Malformed (array, primitive, mixed) → empty.
 */
export function coerceI18nVariables(
	v: I18nVariables | TranslationStrings | string | null | undefined,
): I18nVariables {
	if (v === null || v === undefined) return { in_template: {}, unused: {} };
	if (typeof v === 'string') {
		const trimmed = v.trim();
		if (!trimmed) return { in_template: {}, unused: {} };
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return coerceI18nVariables(parsed as I18nVariables | TranslationStrings);
			}
		} catch {
			/* fall through */
		}
		return { in_template: {}, unused: {} };
	}
	if (typeof v !== 'object' || Array.isArray(v)) return { in_template: {}, unused: {} };

	const obj = v as Record<string, unknown>;
	const hasIn = Object.prototype.hasOwnProperty.call(obj, 'in_template');
	const hasUnused = Object.prototype.hasOwnProperty.call(obj, 'unused');
	if (hasIn || hasUnused) {
		return {
			in_template: coerceFlatMap(obj['in_template']),
			unused: coerceFlatMap(obj['unused']),
		};
	}
	// Legacy bare-key shape — assume everything is `in_template`.
	return { in_template: coerceFlatMap(obj), unused: {} };
}

function coerceFlatMap(v: unknown): TranslationStrings {
	if (v === null || v === undefined) return {};
	if (typeof v === 'string') {
		const trimmed = v.trim();
		if (!trimmed) return {};
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return coerceFlatMap(parsed);
			}
		} catch {
			/* fall through */
		}
		return {};
	}
	if (typeof v !== 'object' || Array.isArray(v)) return {};
	const out: TranslationStrings = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === 'string') out[k] = val;
		else if (val === null || val === undefined) out[k] = '';
		else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
		// Drop nested objects/arrays silently — they shouldn't appear in a flat
		// translation map and forcing String() would produce "[object Object]".
	}
	return out;
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
 * Build a starter `i18n_variables` value for a brand-new translation row.
 * Every key referenced by the template body lands in `in_template` with
 * an empty string. `unused` starts empty.
 */
export function buildInitialStrings(
	templateBody: string,
	templateKey: string,
	logger: Pick<Logger, 'warn'>,
): I18nVariables {
	const used = extractI18nKeys(templateBody, templateKey, logger);
	const in_template: TranslationStrings = {};
	for (const key of used) in_template[key] = '';
	return { in_template, unused: {} };
}

/**
 * Walk every translation row attached to a template and reconcile its
 * `i18n_variables` against the body. Only writes rows that actually
 * changed.
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
		const result = reconcileTranslationStrings(row.i18n_variables, usedKeys);
		if (!result.changed) continue;
		try {
			await items.updateOne(row.id!, { i18n_variables: result.value });
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
